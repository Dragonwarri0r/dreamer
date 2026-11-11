import type {ScriptPolicy} from './interactive-script.ts';
import {RenderIntent, type Capability} from './production.ts';
import {cloudRatio, isCloudVideo} from './cloud-video.ts';

export type ScriptExecutionProfileIssue = {
  code: 'VALIDATION' | 'UNSUPPORTED';
  message: string;
  /** Path relative to one policy.executionProfiles entry. */
  fieldPath: string;
};

/** Validate the author's frozen media limits without creating a render or calling a provider. */
export function scriptExecutionProfileIssue(
  profile: ScriptPolicy['executionProfiles'][number],
  capability: Capability | undefined,
): ScriptExecutionProfileIssue | undefined {
  const invalid = (fieldPath: string, message: string): ScriptExecutionProfileIssue => ({code: 'VALIDATION', fieldPath, message});
  const unsupported = (fieldPath: string, message: string): ScriptExecutionProfileIssue => ({code: 'UNSUPPORTED', fieldPath, message});
  if (!capability?.available || capability.id !== profile.provider || !capability.profiles.includes(profile.profile)) {
    return unsupported('profile', '选定生成能力或规格不可用，请重新选择制作规格');
  }
  if (capability.fingerprint !== profile.configFingerprint) return unsupported('configFingerprint', '选定生成配置已变化，请重新固定制作规格并确认');
  const specification = capability.profileConstraints?.[profile.profile];
  if (!specification) return unsupported('profile', '此媒体规格缺少可校验的执行约束');
  const keys = ['width', 'height', 'fps', 'durationSeconds', 'audio', 'firstLastFrames'];
  if (!keys.every(key => Object.hasOwn(profile.constraints, key))) return invalid('constraints', '发布时必须固定完整媒体约束，请重新选择制作规格');
  const parsed = RenderIntent.shape.constraints.safeParse(profile.constraints);
  if (!parsed.success) return invalid('constraints', '媒体尺寸、时长或音频约束格式无效，请重新选择制作规格');
  const constraints = parsed.data;
  if (profile.quality === 'final' && (!capability.supports.final || !specification.final)) {
    return unsupported('quality', '当前规格仅支持预览，不能作为正式质量发布');
  }
  if (constraints.fps !== specification.fps) return invalid('constraints.fps', `此规格要求 ${specification.fps} fps，不能更改冻结帧率`);
  if (constraints.audio !== specification.audio || constraints.audio && !capability.supports.audio) {
    return invalid('constraints.audio', specification.audio ? '此规格必须保留原生音频' : '此规格不支持生成原生音频');
  }
  if (constraints.firstLastFrames && (!capability.supports.references || !capability.supports.lastFrame ||
    !specification.firstLastFramesForTwo || specification.maxReferences < 2 || specification.minReferences > 2)) {
    return unsupported('constraints.firstLastFrames', '此规格不支持要求首帧与尾帧的执行模式');
  }
  if (isCloudVideo(profile.provider)) {
    const ratio = cloudRatio(profile.profile, constraints.width, constraints.height);
    if (!ratio || !specification.aspectRatios?.includes(ratio)) return invalid('constraints.width', '请选择该云模型支持的分辨率与画幅预设');
    const range = specification.durationRange;
    if (!range) return unsupported('constraints.durationSeconds', '此云端规格缺少可校验的时长范围');
    if (!Number.isInteger(constraints.durationSeconds) || constraints.durationSeconds < range[0] || constraints.durationSeconds > range[1]) {
      return invalid('constraints.durationSeconds', `此规格的每镜秒数上限须为 ${range[0]}–${range[1]} 的整数秒`);
    }
  } else {
    if (constraints.width !== specification.width || constraints.height !== specification.height) {
      return invalid('constraints.width', `此规格要求 ${specification.width} × ${specification.height}，不能更改冻结尺寸`);
    }
    if (Math.abs(constraints.durationSeconds - specification.durationSeconds) >= 0.001) {
      return invalid('constraints.durationSeconds', `此规格要求 ${specification.frames} 帧 / ${specification.fps} fps，不能更改冻结时长`);
    }
  }
}
