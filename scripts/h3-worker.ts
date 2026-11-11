import {spawn} from 'node:child_process';import {existsSync} from 'node:fs';import {resolve} from 'node:path';
const python=process.env.DREAMER_VIDEO_PYTHON??resolve('../short-dreamer/.local/video-venv/bin/python');
if(!existsSync(python))throw new Error('请配置 DREAMER_VIDEO_PYTHON（包含 Pillow，用于参考帧校验）');
const child=spawn(python,[process.argv.includes('--verify')?'workers/h3/config.py':'workers/h3/worker.py'],{stdio:'inherit',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},shell:false});
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>child.kill(signal));
child.on('exit',code=>process.exitCode=code??1);
