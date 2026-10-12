import test from 'node:test';
import assert from 'node:assert/strict';
import {STAR_TIERS,starTier,walletBalance} from '../src/star-effects.js';
import {PetBehavior} from '../src/pet-behavior.js';
import {BUILTIN_SHARKS} from '../src/shark-variants.js';
test('persistent wallet uses the ledger sum and never wraps at three or a visual tier',()=>{
  for(const amount of [0,1,3,7,15,30,60,100,140000])assert.equal(walletBalance({version:1,entries:[{amount}]}),amount);
  assert.equal(walletBalance({entries:[{amount:7},{amount:7},{amount:1}]}),15);
  assert.equal(walletBalance({entries:[{amount:7},{amount:-2}]}),5);
  assert.equal(walletBalance({entries:[{amount:'8'},{amount:Infinity},{amount:1}]}),1);
});
test('eight visual tiers grow monotonically and stay bounded at high balances',()=>{
  assert.deepEqual(STAR_TIERS.map(t=>t.minimum),[0,1,3,7,15,30,60,100]);
  assert.equal(starTier(0).points,0);
  for(let i=1;i<STAR_TIERS.length;i++)assert.ok(STAR_TIERS[i].points>STAR_TIERS[i-1].points);
  assert.equal(starTier(99).minimum,60);assert.equal(starTier(100).minimum,100);
  assert.equal(starTier(1e9),starTier(100));
  const max=starTier(100);assert.ok(max.points+max.dust+max.rings+max.meteors<=30);
});
test('each shark has gentle distinct reward lines while reward language does not wake a nap',()=>{
  const lines=new Set();
  for(const variant of BUILTIN_SHARKS){
    const pet=new PetBehavior({variant:variant.id,now:0,random:()=>.2});pet.startSleep(1);pet.tick(1801);
    lines.add(pet.line('reward',1802).message);assert.equal(pet.state,'sleeping');assert.equal(pet.stars,undefined);
  }
  assert.equal(lines.size,5);
});
