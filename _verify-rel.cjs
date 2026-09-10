const fs = require('fs'), os = require('os'), path = require('path');
const line = fs.readFileSync(path.join(os.homedir(), '.git-credentials'), 'utf8').split(/\r?\n/).find(l => l.includes('github.com'));
const token = line.match(/https:\/\/[^:]+:([^@]+)@github\.com/)[1];
(async () => {
  const h = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'User-Agent': 'verify' };
  const r = await fetch('https://api.github.com/repos/forestkopa/project-kanban/releases/tags/v1.5.4', { headers: h });
  const j = await r.json();
  console.log('status', r.status, '| tag', j.tag_name, '| name', j.name, '| prerelease', j.prerelease, '| draft', j.draft);
  console.log('body 长度', j.body.length, '| 前 80 字:', JSON.stringify(j.body.slice(0, 80)));
  console.log('乱码检测:', /\ufffd/.test(j.body) ? '有替换字符(乱码!)' : '无乱码 OK');
  console.log('assets:', (j.assets || []).map(a => a.name + ' ' + (a.size / 1048576).toFixed(1) + 'MB state=' + a.state));
  const a = (j.assets || [])[0];
  if (a) {
    const d = await fetch(a.url, { headers: { ...h, Accept: 'application/octet-stream' } });
    const b = Buffer.from(await d.arrayBuffer());
    console.log('附件下载: status', d.status, 'bytes', b.length, 'PK头', b.slice(0, 4).toString('hex'));
  }
})();
