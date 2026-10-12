export const STAR_TIERS = Object.freeze([
  {minimum:0,points:0,dust:0,rings:0,meteors:0},
  {minimum:1,points:1,dust:0,rings:0,meteors:0},
  {minimum:3,points:3,dust:0,rings:0,meteors:0},
  {minimum:7,points:6,dust:4,rings:0,meteors:0},
  {minimum:15,points:8,dust:6,rings:0,meteors:0},
  {minimum:30,points:10,dust:8,rings:1,meteors:0},
  {minimum:60,points:12,dust:10,rings:2,meteors:1},
  {minimum:100,points:14,dust:12,rings:2,meteors:2}
].map(Object.freeze));
export const starTier = balance => STAR_TIERS.findLast(tier => Number.isFinite(balance) && balance >= tier.minimum) || STAR_TIERS[0];
export function walletBalance(wallet) {
  const sum = (Array.isArray(wallet?.entries) ? wallet.entries : []).reduce((total, entry) => Number.isSafeInteger(entry?.amount) ? total + entry.amount : total, 0);
  return Number.isSafeInteger(sum) ? Math.max(0,sum) : 0;
}
const POINTS = [[247,57],[40,79],[47,210],[261,160],[153,30],[119,241],[23,141],[223,225],[271,113],[89,39],[187,241],[71,226],[280,199],[206,37]];
const DUST = [[29,105],[58,50],[274,139],[40,179],[97,249],[237,242],[178,28],[259,74],[21,198],[275,219],[74,32],[141,251]];
const STAR = 'M0 -6 1.8 -1.8 6 0 1.8 1.8 0 6 -1.8 1.8 -6 0 -1.8 -1.8Z';
const NS = 'http://www.w3.org/2000/svg';
function svgElement(document,name,attributes={}) { const element=document.createElementNS(NS,name); for(const [key,value] of Object.entries(attributes))element.setAttribute(key,String(value)); return element; }
function build(element,tier) {
  const doc=element.ownerDocument, svg=svgElement(doc,'svg',{viewBox:'0 0 296 264','aria-hidden':'true',class:'star-sky'});
  if(tier.minimum>=15)svg.append(svgElement(doc,'ellipse',{class:'star-halo',cx:148,cy:157,rx:139,ry:99}));
  for(let index=0;index<tier.rings;index++)svg.append(svgElement(doc,'ellipse',{class:`star-orbit star-orbit-${index}`,cx:148,cy:158,rx:132-index*7,ry:88+index*8,'data-star-motion':'orbit','data-phase':index*4200}));
  for(let index=0;index<tier.points;index++){
    const [x,y]=POINTS[index], group=svgElement(doc,'g',{transform:`translate(${x} ${y})`});
    group.append(svgElement(doc,'path',{d:STAR,class:`star-point star-color-${index%3}`,'data-star-motion':'point','data-phase':index*977}));svg.append(group);
  }
  for(let index=0;index<tier.dust;index++){
    const [x,y]=DUST[index], group=svgElement(doc,'g',{transform:`translate(${x} ${y})`});
    group.append(svgElement(doc,'circle',{cx:0,cy:0,r:index%3===0?1.7:1.2,class:'star-dust','data-star-motion':'dust','data-phase':index*619}));svg.append(group);
  }
  for(let index=0;index<tier.meteors;index++)svg.append(svgElement(doc,'path',{d:index?'M20 208l13 -7':'M235 28l-13 7',class:`star-meteor star-meteor-${index}`,'data-star-motion':'meteor','data-phase':index*8000}));
  element.replaceChildren(svg);
}
/** Shared deterministic starfield: one balance and epoch; no reward logic or randomness. */
export function renderStarfield(element,{balance=0,epoch=0,now=Date.now(),reducedMotion=false,paused=false,pausedAt=null,variant='builtin'}={}) {
  if(!element)return;
  balance=Number.isSafeInteger(balance)&&balance>=0?balance:0;
  const tier=starTier(balance);
  if(element.dataset.starTier!==String(tier.minimum)){build(element,tier);element.dataset.starTier=String(tier.minimum);}
  element.dataset.count=String(balance);
  element.dataset.starEpoch=String(Number.isFinite(epoch)?epoch:0);
  element.dataset.starPaused=String(Boolean(paused));
  element.dataset.starPausedAt=String(Number.isFinite(pausedAt)?pausedAt:now);
  element.dataset.starVariant=variant;
  element.classList.toggle('is-visible',balance>0);
  element.classList.toggle('stars-reduced',Boolean(reducedMotion));
  element.classList.toggle('stars-paused',Boolean(paused));
  const time=Math.max(0,(paused&&Number.isFinite(pausedAt)?pausedAt:now)-(Number.isFinite(epoch)?epoch:now));
  for(const point of element.querySelectorAll('[data-star-motion]'))for(const animation of point.getAnimations()){
    if(!animation.animationName)continue;
    animation.currentTime=time+Number(point.dataset.phase||0);
    if(reducedMotion||paused)animation.pause();else animation.play();
  }
}
