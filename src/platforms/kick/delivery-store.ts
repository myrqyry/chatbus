/** Node 24 server-only durable idempotency ledger. No event bodies or tokens. */
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {closeSync,lstatSync,openSync,constants} from 'node:fs';
import {dirname,resolve} from 'node:path';

export type KickDeliveryClaim={status:'claimed';token:string}|{status:'duplicate'|'busy'};
export interface KickDeliveryStore {
 claim(id:string,now:number,expiresAt:number):KickDeliveryClaim|Promise<KickDeliveryClaim>;
 complete(id:string,token:string):boolean|Promise<boolean>;
 release(id:string,token:string):void|Promise<void>;
}
export interface KickSqliteDeliveryStore extends KickDeliveryStore {
 claim(id:string,now:number,expiresAt:number):KickDeliveryClaim;
 complete(id:string,token:string):boolean;
 release(id:string,token:string):void;
 close():void;
}
/** Caller creates the private parent directory. Never open a shared/foreign file. */
export function openKickSqliteDeliveryStore(path:string,options:{leaseMs?:number;maxEntries?:number}={}):KickSqliteDeliveryStore{
 const lease=options.leaseMs??60000,maxEntries=options.maxEntries??20000;
 if(!Number.isSafeInteger(lease)||lease<=0||lease>600000||!Number.isSafeInteger(maxEntries)||maxEntries<=0||maxEntries>100000)throw Error('Invalid Kick delivery store policy');
 const file=resolve(path),parent=lstatSync(dirname(file)),uid=process.getuid?.();
 if(!parent.isDirectory()||(uid!==undefined&&parent.uid!==uid)||(parent.mode&0o077)!==0)throw Error('Kick delivery ledger requires a private parent directory');
 const fd=openSync(file,constants.O_CREAT|constants.O_RDWR|constants.O_NOFOLLOW,0o600);
 try{
  const info=lstatSync(file);
  if(!info.isFile()||(uid!==undefined&&info.uid!==uid)||(info.mode&0o077)!==0)throw Error('Kick delivery ledger requires a private file');
 }finally{closeSync(fd);}
 const db=new DatabaseSync(file);
 try{
  db.exec(`PRAGMA busy_timeout=100; PRAGMA synchronous=FULL;
   CREATE TABLE IF NOT EXISTS kick_deliveries (
    id TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at INTEGER NOT NULL,
    lease_until INTEGER NOT NULL, completed INTEGER NOT NULL CHECK(completed IN (0,1))
   );
   CREATE INDEX IF NOT EXISTS kick_deliveries_expiry ON kick_deliveries(expires_at);`);
  const prune=db.prepare('DELETE FROM kick_deliveries WHERE expires_at <= ?');
  const lookup=db.prepare('SELECT token,lease_until,completed FROM kick_deliveries WHERE id=?');
  const total=db.prepare('SELECT COUNT(*) AS n FROM kick_deliveries');
  const insert=db.prepare('INSERT INTO kick_deliveries(id,token,expires_at,lease_until,completed) VALUES(?,?,?,?,0)');
  const reclaim=db.prepare('UPDATE kick_deliveries SET token=?,expires_at=?,lease_until=? WHERE id=? AND completed=0');
  const finish=db.prepare('UPDATE kick_deliveries SET completed=1 WHERE id=? AND token=? AND completed=0');
  const release=db.prepare('DELETE FROM kick_deliveries WHERE id=? AND token=? AND completed=0');
  return {
   claim(id,now,expiresAt){
    if(!/^[-A-Za-z0-9_]{1,256}$/.test(id)||!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(expiresAt)||expiresAt<=now||expiresAt-now>630001)throw Error('Invalid Kick delivery claim');
    db.exec('BEGIN IMMEDIATE');
    try{
     prune.run(now);
     const existing=lookup.get(id);
     let result:KickDeliveryClaim;
     if(existing?.completed===1)result={status:'duplicate'};
     else if(existing&&Number(existing.lease_until)>now)result={status:'busy'};
     else if(!existing&&Number(total.get()?.n)>=maxEntries)result={status:'busy'};
     else {
      const token=randomUUID(),until=Math.min(expiresAt,now+lease);
      if(existing)reclaim.run(token,expiresAt,until,id);
      else insert.run(id,token,expiresAt,until);
      result={status:'claimed',token};
     }
     db.exec('COMMIT');return result;
    }catch(error){db.exec('ROLLBACK');throw error;}
   },
   complete(id,token){return Number(finish.run(id,token).changes)===1;},
   release(id,token){release.run(id,token);},
   close(){db.close();}
  };
 }catch(error){db.close();throw error;}
}
