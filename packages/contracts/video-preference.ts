import h3Profiles from './h3-profiles.json' with {type:'json'};
import type {Capability} from './production.ts';
export {h3Profiles};

/** A planning default, never permission to submit or to replace an explicit choice. */
export function videoGenerationPreference(capabilities:readonly Capability[]){
 const provider='h3' as const,profile='h3-preview/v1' as const,p=h3Profiles[profile],cap=capabilities.find(c=>c.id===provider),available=!!cap?.available&&cap.profiles.includes(profile),issue=cap?.available&&!cap.profiles.includes(profile)?'本地服务尚不支持低分辨率预览规格，请升级服务或手动选择其他本地规格':cap?.detail??'Provider 未接入';
 return {provider,profile,quality:'draft' as const,available,
  constraints:{width:p.width,height:p.height,fps:p.fps,durationSeconds:p.frames/p.fps,audio:true,firstLastFrames:false},
  detail:available?'开发测试默认使用本地 H3 · 320×576 · 4 步预览 · 原生音画；可手动切换本地高质量规格。':`默认本地视频模型 H3 尚未就绪：${issue}。请检查本地模型与服务，不会自动调用付费模型。`,
  policy:'用户明确指定且已启用的模型优先；不可用时说明原因，不自动切换到付费模型。开发测试默认本地预览；默认选择不授权生成或批量执行。'};
}
