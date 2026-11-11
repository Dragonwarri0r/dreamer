import {test} from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {H3Provider} from '../packages/infra/providers.ts';
import {h3Profiles,videoGenerationPreference} from '../packages/contracts/video-preference.ts';

test('06 全新安装没有 H3 描述文件时仍提供统一规划规格，保持不可用且不自动生成',()=>{
 const capability=new H3Provider(join(tmpdir(),`dreamer-missing-h3-${randomUUID()}`)).describe();
 assert.equal(capability.available,false);
 assert.deepEqual(capability.profiles,Object.keys(h3Profiles));
 const preference=videoGenerationPreference([capability]);
 assert.equal(preference.profile,'h3-preview/v1');
 assert.equal(preference.available,false);
 assert.match(preference.detail,/不会自动调用付费模型/);
});
