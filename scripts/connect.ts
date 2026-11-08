import { DbConnection } from '../web/src/module_bindings';
import { cli, server, database } from './cli';
export function adminToken(): string {
  if(process.env.SPACETIME_TOKEN)return process.env.SPACETIME_TOKEN;
  const info=cli(['login','show','--token']);
  const token=info.match(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/)?.[0];
  if(!token)throw new Error('Log in using spacetime login or supply SPACETIME_TOKEN for the publishing identity');
  return token;
}
export async function connect(token?: string): Promise<DbConnection> {
  return new Promise((resolve,reject)=> {
    const timeout=setTimeout(()=>{conn.disconnect();reject(new Error('Spacetime connection timed out'));},15000);
    const conn=DbConnection.builder().withUri(server).withDatabaseName(database)
      .withToken(token).onConnect(c=>{clearTimeout(timeout);resolve(c);})
      .onConnectError((_ctx,error)=>{clearTimeout(timeout);reject(error);}).build();
  });
}
export async function subscribe(conn: DbConnection): Promise<void> {
  return new Promise((resolve,reject)=> {
    const timer=setTimeout(()=>reject(new Error('Subscription timed out')),15000);
    conn.subscriptionBuilder().onApplied(()=>{clearTimeout(timer);resolve();})
      .onError(ctx=>{clearTimeout(timer);reject(ctx.event);}).subscribeToAllTables();
  });
}
