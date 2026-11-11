import React from 'react';
import type { ExperienceCatalogRelease } from '../../../../packages/contracts/experience-catalog.ts';
import './library.css';

export interface ExperienceLibraryProps {
  releases: ExperienceCatalogRelease[];
  busy: boolean;
  startingUnknown: boolean;
  onStart: (releaseId: string) => void;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
}

/** Loaded pages may be incomplete. Never infer a global latest version from them. */
export function ExperienceLibrary({ releases, busy, startingUnknown, onStart, loading = false, error, onRetry }: ExperienceLibraryProps) {
  const grouped = new Map<string, ExperienceCatalogRelease[]>();
  for (const release of [...releases].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.releaseId.localeCompare(b.releaseId))) {
    const group = grouped.get(release.scriptId) ?? [];
    if (!group.some(item => item.releaseId === release.releaseId)) group.push(release);
    grouped.set(release.scriptId, group);
  }
  return <section className="experience-library" aria-label="已发布的故事" aria-busy={loading}>
    <h2>已发布的故事</h2>
    <p className="muted">选择一个故事，开始新的路线。已有进度保留在“我的体验”。</p>
    {loading && !releases.length && <p role="status">正在加载故事…</p>}
    {error && <div className="inline-warning" role="alert"><p>{releases.length ? '故事目录暂时无法更新，已加载版本仍可查看。' : '暂时无法加载故事。'}{error}</p>{onRetry && <button disabled={loading} onClick={onRetry}>重新加载故事</button>}</div>}
    {!loading && !error && !releases.length && <p>这个工程还没有已发布的故事。</p>}
    <div className="experience-runs experience-library-groups">
      {[...grouped.entries()].map(([scriptId, versions]) => {
        versions.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || b.scriptVersion - a.scriptVersion || a.releaseId.localeCompare(b.releaseId));
        const primary = versions[0];
        return <article className="content-card experience-library-story" key={scriptId} data-script-id={scriptId} data-release-id={primary.releaseId}>
          <h3>{primary.scriptTitle}</h3>
          <ReleaseNotice release={primary}/>
          <button className="primary" disabled={busy || startingUnknown || loading} onClick={() => onStart(primary.releaseId)}>开始故事</button>
          <details className="experience-library-details">
            <summary>故事详情</summary>
            <ReleaseMetadata release={primary}/>
          </details>
          {versions.length > 1 && <details className="experience-library-versions">
            <summary>其他已发布版本（{versions.length - 1}）</summary>
            <ul>{versions.slice(1).map(release => <li key={release.releaseId} data-release-id={release.releaseId}>
              <strong>{release.scriptTitle} · v{release.scriptVersion}</strong>
              <ReleaseNotice release={release}/>
              <ReleaseMetadata release={release}/>
              <button disabled={busy || startingUnknown || loading} onClick={() => onStart(release.releaseId)}>从此版本开始</button>
            </li>)}</ul>
          </details>}
        </article>;
      })}
    </div>
  </section>;
}

function ReleaseNotice({ release }: { release: ExperienceCatalogRelease }) {
  if (!release.mayWaitForPreparation && !release.requiresAuthorReview) return null;
  return <p className="experience-library-notice">{release.mayWaitForPreparation ? '部分剧情根据你的输入准备，需要等待。' : ''}{release.requiresAuthorReview ? '部分内容需要作者确认。' : ''}</p>;
}

function ReleaseMetadata({ release }: { release: ExperienceCatalogRelease }) {
  return <>
    <small>发布版本 v{release.scriptVersion} · {new Date(release.publishedAt).toLocaleString()}</small>
    {!release.mayWaitForPreparation && <p className="muted">视频已准备，可以开始观看。</p>}
    {release.hasDynamicContent && <p className="experience-library-budget">{release.budgetHint}</p>}
  </>;
}
