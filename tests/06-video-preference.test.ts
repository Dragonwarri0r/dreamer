import test from 'node:test';
import assert from 'node:assert/strict';
import {RenderIntent,type Capability} from '../packages/contracts/production.ts';
import {videoGenerationPreference} from '../packages/contracts/video-preference.ts';
import h3Profiles from '../packages/contracts/h3-profiles.json' with {type:'json'};

const capability=(id:Capability['id'],available=true):Capability=>({id,title:id,available,detail:available?'已就绪':'请先配置 API Key',profiles:id==='h3'?['h3-preview/v1','h3-quality/v1']:['720p'],fingerprint:'test',cost:'account-quota',supports:{references:true,lastFrame:true,audio:true,final:true}});
test('06 video planning defaults to local native H3 preview while explicit provider choice stays outside the default',()=>{
 const list=[capability('h3'),capability('seedance'),capability('wan')],before=structuredClone(list);
 const preference=videoGenerationPreference(list);
 assert.equal(preference.provider,'h3');assert.equal(preference.profile,'h3-preview/v1');assert.equal(preference.available,true);
 const intent=RenderIntent.parse({provider:preference.provider,profile:preference.profile,quality:preference.quality,constraints:preference.constraints,prompt:'吉皮梯合上账本。'});
 const profile=h3Profiles['h3-preview/v1'];assert.equal(intent.constraints.width,profile.width);assert.equal(intent.constraints.height,profile.height);assert.equal(intent.constraints.durationSeconds,profile.frames/profile.fps);assert.equal(intent.quality,'draft');assert.equal(intent.constraints.audio,true);assert.equal(intent.constraints.fps,24);
 assert.deepEqual(list,before);assert.match(preference.policy,/明确指定/);assert.match(preference.policy,/不授权生成或批量执行/);
});
test('06 unavailable or missing local H3 never falls back to a ready paid model',()=>{
 const preference=videoGenerationPreference([capability('seedance'),capability('h3',false),capability('wan')]);
 assert.equal(preference.provider,'h3');assert.equal(preference.available,false);assert.match(preference.detail,/API Key/);assert.match(preference.detail,/不会自动调用付费模型/);
 const absent=videoGenerationPreference([capability('wan')]);assert.equal(absent.provider,'h3');assert.equal(absent.available,false);assert.match(absent.detail,/Provider 未接入/);
});

test('06 an older local worker without the preview profile is explicit and does not silently select cloud',()=>{
 const older={...capability('h3'),profiles:['h3-quality/v1']};const preference=videoGenerationPreference([older,capability('wan')]);
 assert.equal(preference.provider,'h3');assert.equal(preference.profile,'h3-preview/v1');assert.equal(preference.available,false);assert.match(preference.detail,/尚不支持低分辨率预览规格/);
});
