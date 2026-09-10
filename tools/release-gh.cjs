// tools/release-gh.cjs — 创建/更新 GitHub Release，并把指定的升级包作为附件挂上去。
//
// 为什么单独写：tools/sync-release.ps1 只建 Release（body 还是占位模板）且【不挂 update.zip 附件】，
// 而本项目的发布纪律是「每个 Release 必须挂 update.zip」，否则服务器的在线升级拿不到下载地址。
//
// 用法：
//   node tools/release-gh.cjs v1.5.4 "C:/Users/Administrator/Downloads/kanban/project-kanban-update.zip"
//   node tools/release-gh.cjs v1.5.4                # 不传 zip 则只建/更新 Release
//
// 说明：
//  - token 依次取 env.GH_PAT → ~/.git-credentials（credential.helper=store 缓存的 PAT）。
//  - Release body 直接从 CHANGELOG.md 抽取对应版本章节，**不经过任何转码**（历史上用 json.dumps
//    默认 ensure_ascii 导致 Release 页中文乱码，这里统一 Node 直读直传 UTF-8）。
//  - 幂等：Release 已存在则 PATCH；同名附件已存在则先删再传。网络抖动自动重试。
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = 'forestkopa/project-kanban';
const API = 'https://api.github.com';
const UPLOADS = 'https://uploads.github.com';

function readToken() {
  if (process.env.GH_PAT) return process.env.GH_PAT.trim();
  const store = path.join(os.homedir(), '.git-credentials');
  if (!fs.existsSync(store)) return null;
  const line = fs.readFileSync(store, 'utf8').split(/\r?\n/).find(l => l.includes('github.com'));
  if (!line) return null;
  const m = line.match(/https:\/\/[^:]+:([^@]+)@github\.com/);
  return m ? m[1].trim() : null;
}

function changelogSection(version) {
  const md = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex(l => l.startsWith('## ' + version));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+v\d/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start + 1, end).join('\n').trim();
}

async function req(url, opts, token, label, tries = 3) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, opts);
      if (r.status === 404) return { status: 404, body: null };
      const text = await r.text();
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + text.slice(0, 300));
      return { status: r.status, body: text ? JSON.parse(text) : null };
    } catch (e) {
      lastErr = e;
      if (i < tries) { console.log(`  ...${label} 第 ${i} 次失败(${e.message.slice(0, 80)})，重试`); await new Promise(r => setTimeout(r, 3000 * i)); }
    }
  }
  throw new Error(label + ' 失败：' + lastErr.message);
}

(async () => {
  const version = process.argv[2];
  const zipPath = process.argv[3];
  if (!version || !/^v\d+\.\d+(\.\d+)?$/.test(version)) {
    console.error('用法: node tools/release-gh.cjs vX.Y[.Z] [update.zip 路径]');
    process.exit(1);
  }
  const token = readToken();
  if (!token) { console.error('未找到 GitHub token（GH_PAT 或 ~/.git-credentials）'); process.exit(1); }

  const notes = changelogSection(version);
  if (!notes) { console.error(`CHANGELOG.md 里没有 ${version} 章节，先补 CHANGELOG 再发版`); process.exit(1); }
  const body = notes + `\n\n---\n\n> 本版本为**不可变里程碑**；\`latest\` 标签已滚动到本版本。\n> 升级包 \`project-kanban-update.zip\` 见下方 Assets（服务器在线升级即取此文件）。`;

  const hdr = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json; charset=utf-8',
    'User-Agent': 'project-kanban-release'
  };

  const payload = JSON.stringify({ tag_name: version, name: version, body, prerelease: false, draft: false });
  const existing = await req(`${API}/repos/${REPO}/releases/tags/${version}`, { headers: hdr }, token, '查询 Release');
  let rel;
  if (existing.status === 404) {
    const r = await req(`${API}/repos/${REPO}/releases`, { method: 'POST', headers: hdr, body: payload }, token, '创建 Release');
    rel = r.body;
    console.log('✅ Release 已创建：' + rel.html_url + '（body 来自 CHANGELOG ' + version + '）');
  } else {
    const r = await req(`${API}/repos/${REPO}/releases/${existing.body.id}`, { method: 'PATCH', headers: hdr, body: payload }, token, '更新 Release');
    rel = r.body;
    console.log('✅ Release 已更新：' + rel.html_url + '（body 同步为 CHANGELOG ' + version + '）');
  }

  if (!zipPath) { console.log('（未传 zip，跳过附件上传）'); return; }
  if (!fs.existsSync(zipPath)) { console.error('找不到 zip：' + zipPath); process.exit(1); }
  const buf = fs.readFileSync(zipPath);
  const name = path.basename(zipPath);

  const assets = await req(`${API}/repos/${REPO}/releases/${rel.id}/assets`, { headers: hdr }, token, '查询附件');
  for (const a of (assets.body || [])) {
    if (a.name === name) {
      await req(`${API}/repos/${REPO}/releases/assets/${a.id}`, { method: 'DELETE', headers: hdr }, token, '删除旧附件');
      console.log('  · 已移除同名旧附件 ' + name + '（id ' + a.id + '）');
    }
  }

  const up = await req(`${UPLOADS}/repos/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { ...hdr, 'Content-Type': 'application/zip', 'Content-Length': String(buf.length) },
    body: buf
  }, token, '上传附件', 4);

  console.log(`✅ 附件已上传：${up.body.name}  ${(up.body.size / 1048576).toFixed(1)} MB`);
  console.log('   下载地址：' + up.body.browser_download_url);
})().catch(e => { console.error('❌ ' + e.message); process.exit(1); });
