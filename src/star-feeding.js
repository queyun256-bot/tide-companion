import {petPointIsInteractive} from './pet-input.js';

export const STAR_FEED_TYPE = 'application/x-tide-star-feed';
let sharedSession = null;
export const isStarFeedDragging = () => Boolean(sharedSession?.active);
const isToken = token => typeof token === 'string' && /^[a-zA-Z0-9-]{20,100}$/.test(token);
const rectContains = (rect,x,y) => rect.width>0 && rect.height>0 && x>=rect.left && x<=rect.right && y>=rect.top && y<=rect.bottom;

function mouthPoint(target,stage) {
  const mouth=stage?.querySelector('.shark .smile');
  if(mouth){
    const matrix=mouth.getScreenCTM();
    if(matrix){const point=new DOMPoint(200,178).matrixTransform(matrix);return {x:point.x,y:point.y};}
  }
  const rect=target.getBoundingClientRect();return {x:rect.left+rect.width*.5,y:rect.top+rect.height*.57};
}
function targetAt(root,desktopStage,x,y) {
  if(desktopStage){
    if(document.hidden || desktopStage.classList.contains('is-dragging') || desktopStage.classList.contains('is-drag-preparing'))return null;
    return petPointIsInteractive(desktopStage,x,y,{includeUi:false}) ? {target:desktopStage,stage:desktopStage} : null;
  }
  for(const target of root.querySelectorAll('tide-pet-preview[data-star-feed-target]')){
    if(!rectContains(target.getBoundingClientRect(),x,y))continue;
    const stage=target.shadowRoot?.querySelector('.pet-stage');
    // A loading preview or the Live2D placeholder is not a pictured companion.
    if(!stage || stage.hidden || !petPointIsInteractive(stage,x,y,{includeUi:false}))continue;
    return {target,stage};
  }
  return null;
}

function animateStar({x,y},mouth) {
  const star=document.createElement('span');star.className='star-feed-flight';star.textContent='✦';star.setAttribute('aria-hidden','true');
  star.style.left=`${x}px`;star.style.top=`${y}px`;star.style.setProperty('--star-feed-dx',`${mouth.x-x}px`);star.style.setProperty('--star-feed-dy',`${mouth.y-y}px`);
  document.body.append(star);setTimeout(()=>star.remove(),850);return star;
}
function announce(message) {
  let status=document.getElementById('star-feed-status');
  if(!status){status=document.createElement('span');status.id='star-feed-status';status.className='star-feed-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');document.body.append(status);}
  status.textContent=message;
}

/** One installation per document. Source and desktop windows share only a
 * short-lived main-process token; the renderer never changes stars or XP. */
export function installStarFeeding({root=document,api=window.petAPI,desktopStage=null}={}) {
  if(!api?.beginStarFeed || !api?.commitStarFeed || !api?.cancelStarFeed)return {dispose(){},recheck(){}};
  const events=new AbortController(),signal=events.signal;
  const pending=new Map(),committing=new Set(),timers=new Set();
  let sourceToken=null,hovered=null,sessionExpiry=null,disposed=false;
  const later=(callback,delay)=>{const timer=setTimeout(()=>{timers.delete(timer);callback();},delay);timers.add(timer);return timer;};
  const clearHover=()=>{hovered?.target.classList.remove('is-star-feed-hover');hovered=null;};
  function applySession(next) {
    const previousToken=sharedSession?.token,wasActive=Boolean(sharedSession);
    if(next?.active && isToken(next.token))sharedSession={token:next.token,active:true};
    else if(!next?.token || next.token===sharedSession?.token)sharedSession=null;
    desktopStage?.classList.toggle('is-star-feed-drag',Boolean(sharedSession));
    document.documentElement.classList.toggle('has-star-feed-drag',Boolean(sharedSession));
    if(previousToken!==sharedSession?.token){
      if(sessionExpiry){clearTimeout(sessionExpiry);timers.delete(sessionExpiry);sessionExpiry=null;}
      if(sharedSession){const token=sharedSession.token;sessionExpiry=later(()=>cancel(token),30000);}
    }
    if(!sharedSession)clearHover();
    if(wasActive && !sharedSession)document.dispatchEvent(new CustomEvent('tide-star-feed-session-end'));
  }
  function cancel(token) {
    if(!isToken(token))return;
    Promise.resolve(api.cancelStarFeed({token})).catch(()=>{}).finally(()=>{if(sharedSession?.token===token)applySession({token,active:false});});
    if(sourceToken===token)sourceToken=null;
  }
  function canReceive(event) {return Boolean(sharedSession?.active && event.dataTransfer && Array.from(event.dataTransfer.types).includes(STAR_FEED_TYPE));}
  function dragOver(event) {
    if(!canReceive(event))return;
    const next=targetAt(root,desktopStage,event.clientX,event.clientY);
    if(next?.target!==hovered?.target){clearHover();hovered=next;hovered?.target.classList.add('is-star-feed-hover');}
    if(next){event.preventDefault();event.dataTransfer.dropEffect='move';}
    else event.dataTransfer.dropEffect='none';
  }
  root.addEventListener('dragstart',event=>{
    const source=event.composedPath().find(node=>node instanceof Element && node.matches('[data-star-feed-source]'));
    if(!source)return;
    if(source.disabled || source.getAttribute('aria-disabled')==='true' || !event.dataTransfer || sharedSession){event.preventDefault();return;}
    const token=crypto.randomUUID();sourceToken=token;
    event.dataTransfer.setData(STAR_FEED_TYPE,token);event.dataTransfer.effectAllowed='move';
    const icon=source.querySelector('[data-star-feed-icon]') || source;
    const rect=icon.getBoundingClientRect();event.dataTransfer.setDragImage(icon,Math.round(rect.width/2),Math.round(rect.height/2));
    applySession({token,active:true});
    const ready=Promise.resolve().then(()=>api.beginStarFeed({token}));pending.set(token,ready);
    ready.then(result=>{if(result?.token!==token)throw new Error('Star feed not ready');}).catch(()=>{cancel(token);announce('星星还在这里，稍后再试试。');}).finally(()=>pending.delete(token));
  },{signal});
  root.addEventListener('dragenter',dragOver,{signal});
  root.addEventListener('dragover',dragOver,{signal});
  root.addEventListener('dragleave',event=>{if(!(event.relatedTarget instanceof Node) || !root.contains(event.relatedTarget))clearHover();},{signal});
  root.addEventListener('drop',async event=>{
    if(!canReceive(event))return;
    const token=event.dataTransfer.getData(STAR_FEED_TYPE),hit=targetAt(root,desktopStage,event.clientX,event.clientY);
    if(!hit || token!==sharedSession.token || !isToken(token)){event.dataTransfer.dropEffect='none';clearHover();return;}
    event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect='move';clearHover();
    if(committing.has(token))return;
    committing.add(token);
    const location={x:event.clientX,y:event.clientY},mouth=mouthPoint(hit.target,hit.stage);
    // The native drag is over; capture the destination before a persisted state
    // broadcast replaces the hand-journal preview.
    try{
      await pending.get(token);
      const result=await api.commitStarFeed({token});
      if(!result?.ok){announce(result?.message || '这颗星星没有花掉，可以再试一次。');return;}
      if(result.duplicate)return;
      animateStar(location,mouth);
      hit.target.dispatchEvent(new CustomEvent('tide-star-fed',{detail:result,bubbles:true,composed:true}));
      announce(result.growth?.maxLevel ? '星星收下啦，陪你待一会儿。' : '星星收下啦，经验增加了 1。');
    }catch{announce('这次没能收下星星，稍后再试试。');}
    finally{committing.delete(token);cancel(token);}
  },{signal});
  root.addEventListener('dragend',event=>{
    clearHover();const token=sourceToken;
    // An accepted native drop may still be queued in another busy renderer.
    // Its receiver or main's expiry owns completion; cancellation must not race
    // that IPC. A rejected drop/escape can relinquish the star immediately.
    if(token && event.dataTransfer?.dropEffect!=='move')cancel(token);
  },{signal});
  document.addEventListener('keydown',event=>{if(event.key==='Escape' && sourceToken)cancel(sourceToken);},{capture:true,signal});
  window.addEventListener('pagehide',()=>{if(sourceToken)cancel(sourceToken);},{signal});
  const unsubscribe=api.onStarFeedSession?.(applySession);
  applySession(sharedSession);
  return {recheck(){applySession(sharedSession);},dispose(){
    if(disposed)return;disposed=true;
    events.abort();unsubscribe?.();clearHover();for(const timer of timers)clearTimeout(timer);timers.clear();
    if(sourceToken)cancel(sourceToken);
    desktopStage?.classList.remove('is-star-feed-drag');
  }};
}
