export type RepeatMatch = 'exact' | 'normalized' | 'near';
export type RepeatSenderScope = 'sender' | 'channel';
export interface RepeatDetectorOptions {
  match?: RepeatMatch;
  senderScope?: RepeatSenderScope;
  /** Inactivity window, measured in local receipt time. */
  windowMs?: number;
  maxEntries?: number;
}
export interface RepeatInput {
  id: string;
  scope: string;
  sender: string;
  text: string;
  /** Exact discriminator for non-text content (emote IDs, media, replies). */
  variant?: string;
  now?: number;
}
export interface RepeatObservation {
  firstId: string;
  latestId: string;
  count: number;
  uniqueSenderCount: number;
  lastAt: number;
}
interface Group extends RepeatObservation {
  scope: string;
  partition: string;
  text: string;
  senders: Set<string>;
}
const normalize = (text: string) => text.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase();
// Bounded single-edit comparison against the original, never a chain of
// progressively drifting messages. Short reactions retain exact meaning.
function near(a: string,b: string): boolean {
  if (a.length < 16 || b.length < 16 || a.length > 512 || b.length > 512 ||
      Math.abs(a.length-b.length)>1) return false;
  if(a.length>b.length) [a,b]=[b,a];
  let i=0,j=0,edits=0;
  while(i<a.length && j<b.length){
    if(a[i]===b[j]){i++;j++;continue;}
    if(++edits>1)return false;
    if(a.length===b.length)i++;
    j++;
  }
  return edits+(b.length-j)+(a.length-i)<=1;
}
/** Optional, bounded observation. Does not filter, mutate, or deliver chat events. */
export function createRepeatDetector(options: RepeatDetectorOptions = {}) {
  const {match='exact',senderScope='sender',windowMs=15000,maxEntries=1024}=options;
  if(!Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>10000 ||
     !Number.isFinite(windowMs)||windowMs<=0)throw new RangeError('Invalid repeat cache bounds');
  const groups=new Map<string,Group>();
  const seen=new Map<string,number>();
  let lastNow=-Infinity;
  const prune=(now:number)=>{
    for(const [key,time] of seen){if(now-time<=windowMs)break;seen.delete(key);}
    for(const [key,g] of groups){if(now-g.lastAt<=windowMs)break;groups.delete(key);}
  };
  return {
    observe(input:RepeatInput, isActive?: (firstId:string)=>boolean):RepeatObservation|undefined {
      const now=Math.max(lastNow,input.now??Date.now());
      if(!Number.isFinite(now)||!input.id||!input.scope||!input.sender||!input.text.trim())return;
      lastNow=now;prune(now);
      const eventKey=JSON.stringify([input.scope,input.id]);
      if(seen.has(eventKey))return;
      seen.set(eventKey,now);
      if(seen.size>maxEntries)seen.delete(seen.keys().next().value!);
      const text=match==='exact'||input.variant?input.text:normalize(input.text);
      const partition=JSON.stringify([input.scope,senderScope==='sender'?input.sender:'',input.variant??'']);
      let key=JSON.stringify([partition,text]);
      let group=groups.get(key);
      if(!group&&match==='near'&&!input.variant){
        // Scan at most 64 most recent groups, only on an exact miss.
        let checked=0;
        for(const [candidate,g] of Array.from(groups.entries()).reverse()){
          if(++checked>64)break;
          if(g.partition===partition&&near(g.text,text)){key=candidate;group=g;break;}
        }
      }
      // Cap group membership too; begin a new group rather than report
      // inaccurate participant counts or let one spam wave grow memory forever.
      if(!group||group.count>=maxEntries||(isActive&&!isActive(group.firstId))){
        group={scope:input.scope,partition,text,firstId:input.id,latestId:input.id,count:0,uniqueSenderCount:0,lastAt:now,senders:new Set()};
      }
      group.count++;group.latestId=input.id;group.lastAt=now;
      group.senders.add(input.sender);group.uniqueSenderCount=group.senders.size;
      groups.delete(key);groups.set(key,group);
      if(groups.size>maxEntries)groups.delete(groups.keys().next().value!);
      const {firstId,latestId,count,uniqueSenderCount,lastAt}=group;
      return {firstId,latestId,count,uniqueSenderCount,lastAt};
    },
    forget(scope:string,firstId:string):void {
      for(const [key,g] of groups)if(g.scope===scope&&g.firstId===firstId)groups.delete(key);
    },
    clear():void {groups.clear();seen.clear();lastNow=-Infinity;},
  };
}
