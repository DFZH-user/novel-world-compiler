import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ManagedSessionUpdate } from '../../electron/main/managed-session-update';
import type { TavernCardV2 } from '../../src/shared/contracts';
import type { SessionWorldBook } from '../../src/shared/play-session-assembly';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, {recursive:true,force:true}); });
async function fixture() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nw-update-test-'));roots.push(root);
  const handle={resourceKey:'stable-project-session',worldId:'world',avatar:'card.png',chatFile:'existing-chat'};
  const target=(generation:string) => ({generation,
    world:{name:'世界书',description:generation,entries:generation==='v1'?{old:{content:'旧条目'}}:{}} as unknown as SessionWorldBook,
    card:{data:{name:'旁白',description:generation}} as TavernCardV2});
  let world=structuredClone(target('v1').world),card=structuredClone(target('v1').card.data);
  let fail=false; const writes={world:0,card:0};
  const api={getWorld:async()=>structuredClone(world),getCharacter:async()=>({data:structuredClone(card)}),
    updateWorld:async(_id:string,value:SessionWorldBook)=>{writes.world++;world=structuredClone(value);},
    updateCharacter:async(_id:string,value:TavernCardV2)=>{writes.card++;if(fail){fail=false;throw new Error('simulated failure');}card=structuredClone(value.data);}};
  return {root,handle,target,api,writes,world:()=>world,card:()=>card,failNext:()=>{fail=true;},edit:()=>{card.description='用户手工设定';}};
}

it('updates the same resources, removes obsolete entries, and is idempotent across restarts',async()=>{
  const f=await fixture();const service=new ManagedSessionUpdate(f.api,f.root);
  await service.apply(f.handle,f.target('v1'));
  await service.apply(f.handle,f.target('v2'));
  expect(f.world().entries).toEqual({});expect(f.card().description).toBe('v2');
  await new ManagedSessionUpdate(f.api,f.root).apply(f.handle,f.target('v2'));
  expect(f.writes).toEqual({world:1,card:1});
  expect((await fs.readdir(path.join(f.root,'history'))).length).toBe(1);
});
it('does not replace either asset when the user has edited the card',async()=>{
  const f=await fixture();const service=new ManagedSessionUpdate(f.api,f.root);
  await service.apply(f.handle,f.target('v1'));f.edit();
  expect(await service.apply(f.handle,f.target('v2'))).toContain('手工修改');
  expect(f.writes).toEqual({world:0,card:0});expect(f.card().description).toBe('用户手工设定');
});
it('resumes a partially saved update from the durable pending record without repeating completed writes',async()=>{
  const f=await fixture();const service=new ManagedSessionUpdate(f.api,f.root);
  await service.apply(f.handle,f.target('v1'));f.failNext();
  await expect(service.apply(f.handle,f.target('v2'))).rejects.toThrow('simulated failure');
  expect(f.world().description).toBe('v2');expect(f.card().description).toBe('v1');
  await new ManagedSessionUpdate(f.api,f.root).apply(f.handle,f.target('v2'));
  expect(f.writes).toEqual({world:1,card:2});expect(f.card().description).toBe('v2');
});
