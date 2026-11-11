import type {Capability} from '../../../packages/contracts/production.ts';
import type {ScriptPolicy} from '../../../packages/contracts/interactive-script.ts';

/** A deliberate author selection only; unavailable capabilities never become a fallback. */
export function freezeScriptProfile(capability:Capability|undefined,profileId:string,quality?:'draft'|'final'):ScriptPolicy['executionProfiles'][number]{
 if(!capability?.available||!capability.profiles.includes(profileId))throw new Error('此模型或规格尚未就绪，请明确选择已启用的能力');
 const profile=capability.profileConstraints?.[profileId];
 if(!profile)throw new Error('此规格缺少可冻结的执行约束');
 const selectedQuality=quality??(profile.final?'final':'draft');
 if(selectedQuality==='final'&&(!capability.supports.final||!profile.final))throw new Error('该规格仅支持开发预览');
 return {provider:capability.id,profile:profileId,quality:selectedQuality,model:capability.title,configFingerprint:capability.fingerprint,templateVersion:'native-audio/v1',constraints:{width:profile.width,height:profile.height,fps:profile.fps,durationSeconds:profile.durationSeconds,audio:profile.audio,firstLastFrames:false}};
}
