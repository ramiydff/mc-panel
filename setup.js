#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const CONFIG_PATH = path.join(__dirname, 'config.json');

if (fs.existsSync(CONFIG_PATH) && !process.argv.includes('--force')) {
  console.error('config.json موجود مسبقًا. استخدم --force للكتابة فوقه.');
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q, d) =>
  new Promise((r) => rl.question(d ? `${q} [${d}]: ` : `${q}: `, (a) => r(a.trim() || d || '')));

function askHidden(q) {
  return new Promise((resolve) => {
    process.stdout.write(q + ': ');
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    let value = '';
    const onData = (ch) => {
      const s = ch.toString('utf8');
      if (s === '\n' || s === '\r' || s === '') {
        if (stdin.isTTY) stdin.setRawMode(wasRaw);
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(value);
      } else if (s === '') {
        process.exit(1);
      } else if (s === '') {
        value = value.slice(0, -1);
      } else {
        value += s;
      }
    };
    stdin.on('data', onData);
  });
}

const token = () => crypto.randomBytes(24).toString('base64url');

(async () => {
  console.log('\n— إعداد لوحة السيرفر —\n');

  const publicAddress = await ask('العنوان اللي بيكتبه اللاعبون (دومين أو آيبي السيرفر الوسيط)');
  const owner = await ask('اسم المستخدم للمالك (أنت)', 'owner');
  let password = '';
  while (password.length < 8) {
    password = await askHidden('كلمة مرور المالك (٨ أحرف فأكثر)');
    if (password.length < 8) console.log('قصيرة — جرّب مرة ثانية.');
  }
  const myName = await ask('اسم جهازك', 'جهازي');
  const friendName = await ask('اسم جهاز صاحبك', 'جهاز صاحبي');

  const salt = crypto.randomBytes(16).toString('hex');
  const config = {
    publicAddress,
    ports: { players: 25565, agents: 7000, web: 8080 },
    activeMachine: 'main-pc',
    autoFailover: true,
    users: [
      { username: owner, role: 'owner', salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') },
    ],
    machines: [
      { id: 'main-pc', name: myName, mode: 'agent', localPort: 25565, token: token(), proxyProtocol: false, savedAddresses: [] },
      { id: 'backup-pc', name: friendName, mode: 'agent', localPort: 25565, token: token(), proxyProtocol: false, savedAddresses: [] },
    ],
  };

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  rl.close();

  console.log('\nجاهز. شغّل اللوحة بـ: node relay.js\n');
  console.log('مفاتيح الأجهزة (تُدخل في الوكيل على كل جهاز):\n');
  for (const m of config.machines) {
    console.log(`  ${m.name}`);
    console.log(`    معرّف الجهاز : ${m.id}`);
    console.log(`    المفتاح      : ${m.token}\n`);
  }
  console.log(`اللوحة: http://${publicAddress}:8080 — ادخل باسم «${owner}»\n`);
})();
