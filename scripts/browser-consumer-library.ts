import { experienceAction } from './experience-ui.ts';
import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { Application } from '../apps/host/application.ts';
import { createHost } from '../apps/host/server.ts';
import { ScriptPlanData } from '../packages/contracts/interactive-script.ts';
import type { ScriptRelease } from '../packages/contracts/experience.ts';

const output = resolve(process.env.DREAMER_BROWSER_OUTPUT ?? 'test-results/ui-ux-fixes-20261023/library');
mkdirSync(output, { recursive: true });
const root = mkdtempSync(join(tmpdir(), 'dreamer-library-ux-')), app = new Application(root, { providers: [], recover: false }), projectId = randomUUID();
function command(operation: string, payload: any): any { return app.bus.execute({ projectId, requestId: randomUUID(), operation, payload }, { source: 'human' }).result; }
command('project.create', { title: '消费目录与首载状态测试' });
const activity = randomUUID(), entry = randomUUID(), ending = randomUUID();
const plan = ScriptPlanData.parse({ schemaVersion: 1, title: '同名故事', chapterRefs: [], entryNodeId: entry,
  nodes: [{ id: entry, type: 'activity', activityId: activity, title: '选择开始', outlineOrder: 0, next: ending }, { id: ending, type: 'ending', title: '结局', endingKey: 'done', summary: '故事已完成', outlineOrder: 1 }],
  activities: [{ id: activity, type: 'choice', version: 1, label: '选择一个方向', presentation: { rendererKey: 'choice', prompt: '请选择' }, config: { options: [{ id: 'left', label: '向左' }, { id: 'right', label: '向右' }] } }] });
let script = command('script.create', plan);
const releases: ScriptRelease[] = [];
for (let i = 0; i < 33; i++) {
  if (i) script = command('script.edit', { id: script.id, expectedSeq: script.seq, ops: [{ op: 'title.set', title: i === 32 ? '同名故事' : `改名前版本 ${i}` }] });
  releases.push(command('script.publish', { id: script.id, expectedSeq: script.seq, kind: 'playback' }).release);
}
const another = command('script.create', plan), anotherRelease = command('script.publish', { id: another.id, expectedSeq: another.seq, kind: 'playback' }).release;
const existing = app.experienceRuntime.start({ projectId, uid: 'library-reader' }, { protocolVersion: 1, requestId: randomUUID(), projectId, releaseId: releases[0].id, mode: 'playback' }).view;
const server = createHost(app);
await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } }), errors: string[] = [], checks: string[] = [];
page.on('pageerror', error => errors.push(error.message));
const url = (runId?: string) => `${base}/?${new URLSearchParams({ project: projectId, window: randomUUID(), editor: 'experience', title: '互动体验', binding: 'uid:library-reader', ...(runId ? { object: runId } : {}) })}`;
const library = page.locator('.experience-library'), story = () => library.locator(`[data-script-id="${script.id}"]`);
try {
  let releaseCatalog!: () => void;
  const catalogGate = new Promise<void>(resolve => { releaseCatalog = resolve; });
  await page.route('**/api/experience/catalog?*', async route => {
    await catalogGate;
    const response = await route.fetch(), body = await response.json();
    // Equal timestamps can occur for quick successive publications. Scramble their
    // arrival order without changing stored releases or pagination cursors.
    body.releases = body.releases.map((release: any) => release.scriptId === script.id ? { ...release, publishedAt: '2030-01-01T00:00:00.000Z' } : release).reverse();
    await route.fulfill({ response, json: body });
  });
  await page.goto(url());
  await page.getByText('正在加载故事…', { exact: true }).waitFor();
  await page.locator('.experience-resume').getByText('继续体验', { exact: true }).waitFor();
  assert.equal(await page.getByText('这个工程还没有已发布的故事。', { exact: true }).count(), 0);
  await page.screenshot({ path: join(output, '01-library-loading-mobile.png') });
  releaseCatalog();
  await page.waitForFunction(() => document.querySelectorAll('.experience-library-story').length === 2);
  assert.equal(await library.getByRole('button', { name: '开始故事', exact: true }).count(), 2);
  assert.equal(await story().locator('.experience-library-details').evaluate((element: HTMLDetailsElement) => element.open), false);
  assert.equal(await story().locator('.experience-library-details small').isVisible(), false);
  await story().locator('.experience-library-details > summary').click();
  assert.equal(await story().locator('.experience-library-details small').isVisible(), true);
  assert.equal(await story().locator('.experience-library-details details').count(), 0);
  await story().locator('.experience-library-details > summary').click();
  checks.push('故事卡默认只保留标题与开始入口；版本和发布时间一层展开可见，无多余嵌套');
  assert.equal(await library.getByRole('button', { name: '从此版本开始', exact: true }).count(), 0);
  const geometry = await page.evaluate(() => {
    const button = [...document.querySelectorAll('.experience-runs button.content-card')].find(element => element.textContent?.includes('继续体验'))!;
    const a = button.getBoundingClientRect(), b = document.querySelector('.experience-library')!.getBoundingClientRect();
    return { resumeTop: a.top, resumeBottom: a.bottom, libraryTop: b.top, viewport: innerHeight, pageWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth };
  });
  assert.ok(geometry.resumeBottom < geometry.libraryTop, JSON.stringify(geometry));
  assert.ok(geometry.resumeBottom < geometry.viewport, JSON.stringify(geometry));
  assert.equal(geometry.pageWidth, geometry.viewportWidth);
  await page.screenshot({ path: join(output, '02-grouped-library-mobile.png') });
  checks.push('目录首载显示加载状态且不阻塞存档读取；已有进度置顶并在手机首屏可见，不误报为空');
  checks.push('33 个改名版本按稳定 scriptId 聚合，同名独立剧本保持分开；旧版本默认折叠');

  const primary = await story().getAttribute('data-release-id');
  assert.equal(primary, releases.at(-1)!.id);
  await page.getByRole('button', { name: '更多已发布版本', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.experience-library [data-release-id]').length === 34);
  await page.waitForTimeout(1700);
  assert.equal(await story().getAttribute('data-release-id'), primary);
  assert.equal(await page.getByRole('button', { name: '更多已发布版本', exact: true }).count(), 0);
  assert.equal(await library.locator('[data-release-id]').count(), 34);
  assert.equal((await library.innerText()).includes('最新'), false);
  await page.unroute('**/api/experience/catalog?*');
  await story().locator('.experience-library-versions > summary').click();
  const old = story().locator(`li[data-release-id="${releases[0].id}"]`);
  await old.getByRole('button', { name: '从此版本开始', exact: true }).click();
  await page.getByRole('button', { name: '更多体验操作', exact: true }).waitFor();
  const currentRuns = app.experienceRuntime.runs({ projectId, uid: 'library-reader' });
  assert.equal(currentRuns.length, 2);
  assert.equal(currentRuns.find(run => run.id !== existing.run.id)!.releaseId, releases[0].id);
  checks.push('同毫秒发布优先较高稿件版本；分页和刷新保留分组，选择旧版按原 releaseId 开始且既有进度不变');

  let releaseHistory!: () => void;
  const historyGate = new Promise<void>(resolve => { releaseHistory = resolve; });
  await page.route('**/api/experience/history?*', async route => { await historyGate; await route.continue(); });
  await experienceAction(page, '回看与导出视频');
  await page.getByText('正在加载已走路线…', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), '返回当前体验');
  assert.equal(await page.getByText('当前还没有已经完成的视频片段。', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '导出已走路线 MP4', exact: true }).count(), 0);
  assert.equal(await page.locator('.experience-history-exports').evaluate((element: HTMLDetailsElement) => element.open), false);
  await page.locator('.experience-history-exports > summary').click();
  assert.equal(await page.getByRole('button', { name: '导出已走路线 MP4', exact: true }).isDisabled(), true);
  await page.screenshot({ path: join(output, '03-history-loading-mobile.png') });
  releaseHistory();
  await page.getByText('当前还没有已经完成的视频片段。', { exact: true }).waitFor();
  await page.unroute('**/api/experience/history?*');
  checks.push('回看首载显示加载状态、禁用导出；成功读取后才显示真实空记录');

  await page.getByRole('button', { name: '返回当前体验', exact: true }).click();
  let failHistory = true;
  await page.route('**/api/experience/history?*', async route => failHistory ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: '测试回看暂时不可用' } }) }) : route.continue());
  await experienceAction(page, '回看与导出视频');
  await page.getByRole('button', { name: '重新加载回看', exact: true }).waitFor();
  assert.equal(await page.getByText('当前还没有已经完成的视频片段。', { exact: true }).count(), 0);
  failHistory = false;
  await page.getByRole('button', { name: '重新加载回看', exact: true }).click();
  await page.getByText('当前还没有已经完成的视频片段。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '重新加载回看', exact: true }).count(), 0);
  await page.unroute('**/api/experience/history?*');
  checks.push('回看首载失败显示可重试错误；恢复后清理错误，不混淆空记录');

  let failCatalog = true;
  await page.route('**/api/experience/catalog?*', async route => failCatalog ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: '测试目录暂时不可用' } }) }) : route.continue());
  await page.goto(url());
  await page.getByRole('button', { name: '重新加载故事', exact: true }).waitFor();
  assert.ok(await page.locator('.experience-resume').getByText('继续体验', { exact: true }).count());
  assert.equal(await page.getByText('这个工程还没有已发布的故事。', { exact: true }).count(), 0);
  failCatalog = false;
  await page.getByRole('button', { name: '重新加载故事', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.experience-library-story').length === 2);
  assert.equal(await page.getByRole('button', { name: '重新加载故事', exact: true }).count(), 0);
  await page.unroute('**/api/experience/catalog?*');
  checks.push('目录首载失败明确显示重试入口；重试恢复后显示故事，不误报没有发布');
  assert.deepEqual(errors, []);
  assert.equal(app.production.jobs.list(projectId).length, 0);
  assert.equal(app.experienceRuntime.view({ projectId, uid: 'library-reader' }, existing.run.id).run.stateSeq, existing.run.stateSeq);
  assert.ok(anotherRelease.id);
  const report = { passed: true, checks, errors, geometry, releaseCount: 34, storyCount: 2, modelCalls: 0, providerJobs: 0, nativePhoneTested: false };
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await page.screenshot({ path: join(output, 'failure.png'), fullPage: true });
  throw error;
} finally {
  await browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); app.close(); rmSync(root, { recursive: true, force: true });
}
