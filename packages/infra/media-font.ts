import {existsSync,globSync} from 'node:fs';
import {ensure} from '../contracts/foundation.ts';

/** Installed system fonts only; font files are not distributed with Dreamer. */
export function mediaFont() {
 const font = [
  {file:'/System/Library/Fonts/PingFang.ttc',family:'PingFang SC'},
  {file:'/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',family:'Noto Sans CJK SC'},
  ...(process.platform==='darwin'
   ? globSync('/System/Library/AssetsV2/com_apple_MobileAsset_Font*/*.asset/AssetData/PingFang.ttc').map(file=>({file,family:'PingFang SC'}))
   : []),
  // Minimal macOS images may omit the downloadable PingFang asset.
  {file:'/System/Library/Fonts/STHeiti Light.ttc',family:'Heiti SC'},
 ].find(candidate=>existsSync(candidate.file));
 ensure(font,'UNSUPPORTED','未找到中文媒体字体；macOS 需要 PingFang 或 Heiti，Ubuntu/Debian 请安装 fonts-noto-cjk（见 docs/quickstart.md）');
 return font;
}

export const filterPath=(path:string)=>path.replaceAll('\\','\\\\').replaceAll(':','\\:').replaceAll("'","\\'").replaceAll(',','\\,').replaceAll('[','\\[').replaceAll(']','\\]');
