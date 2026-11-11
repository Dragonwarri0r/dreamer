import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Capability} from '../packages/contracts/production.ts';
import {cloudConstraints} from '../packages/contracts/cloud-video.ts';
import {freezeScriptProfile} from '../apps/studio/src/script-production-policy.ts';

const capability=(id:Capability['id'],available=true):Capability=>({id,title:id,available,detail:'isolated capability',profiles:['preview','quality'],profileConstraints:{preview:{...cloudConstraints('wan','720p'),final:false},quality:cloudConstraints('wan','720p')},fingerprint:'a'.repeat(64),cost:id==='h3'?'local':'account-quota',supports:{references:true,lastFrame:true,audio:true,final:true}});
test('11 explicit script profile selection freezes complete constraints and refuses unavailable paid capabilities',()=>{
 assert.throws(()=>freezeScriptProfile(capability('wan',false),'quality'),/未就绪/);
 assert.throws(()=>freezeScriptProfile(undefined,'quality'),/未就绪/);
 assert.throws(()=>freezeScriptProfile(capability('h3'),'missing'),/未就绪/);
 const local=freezeScriptProfile(capability('h3'),'preview');assert.equal(local.provider,'h3');assert.equal(local.quality,'draft');assert.equal(local.configFingerprint,'a'.repeat(64));assert.deepEqual(Object.keys(local.constraints).sort(),['audio','durationSeconds','firstLastFrames','fps','height','width']);
 const explicitCloud=freezeScriptProfile(capability('wan'),'quality','draft');assert.equal(explicitCloud.provider,'wan');assert.equal(explicitCloud.quality,'draft');
});
test('11 script profile cannot turn preview into final or retain obsolete fingerprint by default',()=>{
 assert.throws(()=>freezeScriptProfile(capability('h3'),'preview','final'),/预览/);
 const prior=freezeScriptProfile(capability('h3'),'quality'),updated=freezeScriptProfile({...capability('h3'),fingerprint:'b'.repeat(64)},'quality');assert.equal(updated.quality,'final');assert.notEqual(updated.configFingerprint,prior.configFingerprint);assert.equal(prior.configFingerprint,'a'.repeat(64));
});
