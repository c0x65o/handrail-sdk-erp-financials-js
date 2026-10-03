// Disposable Unix-socket-only PostgreSQL. Never reads app/database credentials.
import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';
import console from 'node:console';
import { URL } from 'node:url';
import { setTimeout } from 'node:timers';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Pool } from 'pg';
const root = process.env.ERP_FINANCIALS_EPHEMERAL_ROOT;
if (!root || !root.startsWith('/')) throw Error('Set ERP_FINANCIALS_EPHEMERAL_ROOT to an approved disposable writable directory');
await mkdir(root, { recursive: true });
const directory = await mkdtemp(join(root, 'epg-'));
const bin = process.env.ERP_FINANCIALS_POSTGRES_BIN ?? '/usr/lib/postgresql/15/bin';
const data = join(directory, 'data');
const init = spawnSync(join(bin, 'initdb'), ['-D', data, '-A', 'trust', '--no-locale'], { encoding: 'utf8' });
if (init.status !== 0) throw Error(init.stderr);
const server = spawn(join(bin, 'postgres'), ['-D', data, '-k', directory, '-p', '55439', '-c', "listen_addresses="], { stdio: ['ignore', 'ignore', 'pipe'] });
let serverLog = ''; server.stderr.on('data', b => { serverLog += b; });
const pool = new Pool({host:directory,port:55439,database:'postgres',max:1});
try {
  let ready = false;
  for (let i=0;i<100;i++) { try { await pool.query('select 1'); ready=true; break; } catch { await new Promise(r=>setTimeout(r,50)); } }
  if (!ready) throw Error(serverLog);
  const {rows:[proof]} = await pool.query("select current_setting('data_directory') as data_directory,current_setting('listen_addresses') as listen_addresses,inet_server_addr() as network_address,version() as version");
  if (proof.data_directory !== data || proof.listen_addresses !== '' || proof.network_address !== null) throw Error('Isolation proof failed');
  console.log('ISOLATION VERIFIED', JSON.stringify(proof));
  await pool.query('create database erp_financials_test_correction');
  const url = new URL('postgresql:///erp_financials_test_correction'); url.searchParams.set('host', directory); url.searchParams.set('port','55439');
  const args = process.argv.slice(2);
  const child = spawn(resolve('node_modules/.bin/vitest'), ['run', ...(args.length ? args : ['test/postgres.integration.test.ts']), '--maxWorkers=1', '--no-file-parallelism'], { stdio:'inherit', env:{...process.env, ERP_FINANCIALS_TEST_DATABASE_URL:url.href} });
  process.exitCode = await new Promise(r=>child.once('exit', code=>r(code ?? 1)));
} finally {
  await pool.end();
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise(r=>server.once('exit', r));
  }
  await rm(directory,{recursive:true,force:true});
  console.log('EPHEMERAL POSTGRES REMOVED');
}
