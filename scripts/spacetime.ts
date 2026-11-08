import { spawnSync } from 'node:child_process';
import { cliCommand } from './cli';
const command=cliCommand(process.argv.slice(2));
const result=spawnSync(command.binary,command.args,{stdio:'inherit'});
if(result.error)throw result.error;
process.exitCode=result.status??1;
