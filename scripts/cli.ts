import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
const localRoot=resolve('.tools/spacetime');
const local=resolve(localRoot,'spacetime');
export function cliCommand(args: string[]) {
  const binary=process.env.SPACETIME_CLI ?? (existsSync(local)?local:'spacetime');
  const prefix=binary===local?[`--root-dir=${localRoot}`]:[];
  return {binary,args:[...prefix,...args]};
}
/** Capture login information internally. Never print this result when --token is used. */
export function cli(args: string[]): string {
  const command=cliCommand(args);
  const r=spawnSync(command.binary,command.args,{encoding:'utf8',maxBuffer:8*1024*1024,timeout:120000});
  if(r.error)throw r.error;
  if(r.status!==0)throw new Error(r.stderr||r.stdout||`spacetime exited ${r.status}`);
  return r.stdout;
}
export const server=process.env.SPACETIME_SERVER??'http://127.0.0.1:3000';
export const database=process.env.SPACETIME_DATABASE??'lantern';
