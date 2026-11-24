import {nonnegative,validHashtag} from './extract.mjs';
export function instagramUrl(tag){return 'https://www.instagram.com/explore/tags/'+encodeURIComponent(validHashtag(tag))+'/';}
export function instagramLink(value){try{const u=new URL(value),m=u.pathname.match(/^\/reels?\/([\w-]{3,64})\/?$/);if(u.protocol!=='https:'||!['www.instagram.com','instagram.com'].includes(u.hostname)||u.username||u.password||u.port||!m)return null;return {id:'ig_'+m[1],url:'https://www.instagram.com/reel/'+m[1]+'/',platform:'instagram',title:'',hashtags:[],published_at:null,views:null,likes:null};}catch{return null;}}
export function instagramPostLink(value){const reel=instagramLink(value);if(reel)return reel;try{const u=new URL(value),m=u.pathname.match(/^\/p\/([\w-]{3,64})\/?$/);if(!m||u.protocol!=='https:'||u.hostname!=='www.instagram.com'||u.username||u.password||u.port)return null;return {...instagramLink('https://www.instagram.com/reel/'+m[1]+'/'),inspection_url:'https://www.instagram.com/p/'+m[1]+'/'};}catch{return null;}}
export function instagramItem(x){
 if(!x||typeof x!=='object')return null;const code=x.code??x.shortcode;
 if(typeof code!=='string'||!/^[\w-]{3,64}$/.test(code)||!(x.media_type===2||x.is_video===true||x.video_versions?.length||x.__typename==='GraphVideo'))return null;
 const text=String(typeof x.caption==='string'?x.caption:x.caption?.text??x.edge_media_to_caption?.edges?.[0]?.node?.text??'').slice(0,1000);
 const epoch=Number(x.taken_at??x.taken_at_timestamp),hidden=x.like_and_view_counts_disabled===true;
 const pk=String(x.pk??'');
 return {...instagramLink('https://www.instagram.com/reel/'+code+'/'),...(/^\d{10,30}$/.test(pk)?{media_pk:pk}:{}),verified_video:true,title:text,hashtags:[...new Set([...text.matchAll(/#([\p{L}\p{N}_]{1,80})/gu)].map(m=>m[1].toLowerCase()))],published_at:Number.isFinite(epoch)&&epoch>0&&epoch<4102444800?new Date(epoch*1000).toISOString():null,views:hidden?null:nonnegative(x.play_count??x.ig_play_count??x.video_play_count??x.video_view_count??(typeof x.view_count==='object'?x.view_count?.count:x.view_count)),likes:hidden?null:nonnegative(x.like_count??x.edge_media_preview_like?.count??x.edge_liked_by?.count)};
}
export function extractInstagram(data){const q=[data],found=new Map();let count=0;while(q.length&&count++<80000){const x=q.pop();if(!x||typeof x!=='object')continue;const v=instagramItem(x);if(v){const old=found.get(v.id)||{};found.set(v.id,Object.fromEntries(Object.entries({...old,...v}).map(([k,value])=>[k,value??old[k]??null])));continue;}for(const v of Object.values(x))if(v&&typeof v==='object')q.push(v);}return [...found.values()];}
export function instagramIssue(page){
 if(/\/accounts\/login|\/challenge\/|\/checkpoint\//.test(page.url)||(!page.links.length&&/log in|войти|sign up|зарегистрир/i.test(page.text)))return 'Instagram требует вход или проверку. Пройди её вручную в открытом окне Instagram и повтори сбор.';
 if(!page.links.length&&/something went wrong|что-то пошло не так|please wait a few minutes|попробуйте.*позже|page isn.t available|страница недоступна/i.test(page.text))return 'Instagram не загрузил выдачу или ограничил запросы. Подожди и повтори сбор.';
 return null;
}
export const inspectInstagram=`(()=>({url:location.href,text:document.body?.innerText?.slice(0,2000)||'',links:[...document.querySelectorAll('a[href*="/reel/"],a[href*="/reels/"],a[href*="/p/"]')].map(a=>a.href).filter(h=>/\\/(?:reels?|p)\\/[\\w-]{3,64}\\//.test(h)),hydration:[...document.querySelectorAll('script[type="application/json"]')].map(s=>s.textContent).filter(t=>t&&t.length<12000000)}))()`;
