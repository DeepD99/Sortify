'use strict';

// ══════════════════════════════════════════════════════════════════
// CONSTANTS & CONFIG
// ══════════════════════════════════════════════════════════════════
const CYANITE_ENDPOINT = 'https://api.cyanite.ai/graphql';
const LASTFM_ENDPOINT  = 'https://ws.audioscrobbler.com/2.0/';
const SP_SCOPES = 'user-library-read playlist-read-private playlist-modify-private playlist-modify-public';

const KW_CLUSTERS = [
  {words:['workout','gym','run','beast','pump','lift','running','sport','exercise'],  moods:['energetic'],   genres:['electronicDance','pop'],     bpmMin:120},
  {words:['chill','relax','lofi','lo-fi','calm','sleep','ambient','soft','study'],    moods:['calm','chilled'],genres:['ambient'],                  bpmMax:100},
  {words:['party','dance','club','festival','banger','turn','hype','rave'],           moods:['energetic','happy'], genres:['electronicDance','pop'], bpmMin:120},
  {words:['sad','feels','emo','cry','blue','heartbreak','melancholy','depressed'],    moods:['sad','dark'],   genres:['folkCountry','singerSongwriter']},
  {words:['happy','joy','good','summer','fun','upbeat','vibes','sunshine'],           moods:['happy','uplifting'],genres:['pop']},
  {words:['focus','deep','work','concentration','flow','productivity'],               moods:['calm'],         genres:['ambient','classical']},
  {words:['acoustic','folk','coffee','morning','unplugged','raw'],                    genres:['folkCountry','singerSongwriter','blues']},
  {words:['hiphop','rap','hip','hop','trap','drill','bars'],                          genres:['rapHipHop']},
  {words:['rock','metal','punk','grunge','alt','alternative','indie'],                genres:['rock','metal']},
  {words:['jazz','blues','soul','funk','rnb','r&b','groove'],                         genres:['jazz','blues','funkSoul','rnb']},
  {words:['country','western','twang','nashville'],                                   genres:['folkCountry']},
  {words:['night','late','dark','midnight','moody','noir'],                           moods:['dark']},
  {words:['epic','cinematic','score','film','trailer','power'],                       moods:['epic']},
];

const ALL_MOODS  = ['energetic','dark','happy','calm','sad','chilled','romantic','epic','uplifting','aggressive','scary','sexy','ethereal'];
const ALL_GENRES = ['ambient','blues','classical','electronicDance','folkCountry','funkSoul','jazz','latin','metal','pop','rapHipHop','reggae','rnb','rock','singerSongwriter'];

// ══════════════════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════════════════
let spToken=null, userId=null, clientId=null;
let cyToken=null, lfmKey=null;
let allPlaylists=[], selectedPlIds=new Set();
let currentStep=0;

// ══════════════════════════════════════════════════════════════════
// PKCE AUTH
// ══════════════════════════════════════════════════════════════════
function genVerifier(){
  const a=new Uint8Array(32); crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}
async function genChallenge(v){
  const d=new TextEncoder().encode(v);
  const h=await crypto.subtle.digest('SHA-256',d);
  return btoa(String.fromCharCode(...new Uint8Array(h))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}
function redir(){ return window.location.href.split('?')[0].split('#')[0]; }

// ══════════════════════════════════════════════════════════════════
// SPOTIFY API
// ══════════════════════════════════════════════════════════════════
async function spGet(url){
  let res=await fetch(url,{headers:{Authorization:`Bearer ${spToken}`}});
  if(res.status===429){await sleep(parseInt(res.headers.get('Retry-After')||'2')*1000);return spGet(url);}
  if(!res.ok) throw new Error(`Spotify ${res.status}: ${url}`);
  return res.json();
}
async function spPages(url){
  let items=[],next=url;
  while(next){const d=await spGet(next);items=items.concat(d.items||[]);next=d.next;}
  return items;
}
async function spAddToPlaylist(plId,uris){
  for(let i=0;i<uris.length;i+=100){
    await fetch(`https://api.spotify.com/v1/playlists/${plId}/tracks`,{
      method:'POST',
      headers:{Authorization:`Bearer ${spToken}`,'Content-Type':'application/json'},
      body:JSON.stringify({uris:uris.slice(i,i+100)})
    });
  }
}

// ══════════════════════════════════════════════════════════════════
// CYANITE API
// ══════════════════════════════════════════════════════════════════
const CY_QUERY = `
query SortifyTrack($id: ID!) {
  spotifyTrack(id: $id) {
    __typename
    id
    ... on SpotifyTrack {
      audioAnalysisV6 {
        __typename
        ... on AudioAnalysisV6Finished {
          result {
            bpmPrediction { value }
            key { value }
            moodTags
            genreTags
            energyLevel { value }
            valence { value }
          }
        }
        ... on AudioAnalysisV6Processing { }
        ... on AudioAnalysisV6Enqueued  { }
        ... on AudioAnalysisV6Failed    { error { message } }
        ... on AudioAnalysisV6NotAuthorized { message }
      }
    }
  }
}`;

async function cyAnalyze(spotifyTrackId){
  try{
    const res=await fetch(CYANITE_ENDPOINT,{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${cyToken}`},
      body:JSON.stringify({query:CY_QUERY,variables:{id:spotifyTrackId}})
    });
    const json=await res.json();
    const track=json?.data?.spotifyTrack;
    if(!track||track.__typename!=='SpotifyTrack') return null;
    const analysis=track.audioAnalysisV6;
    if(!analysis||analysis.__typename!=='AudioAnalysisV6Finished') return null;
    const r=analysis.result;
    return {
      bpm:r.bpmPrediction?.value||null,
      key:r.key?.value||null,
      moods:r.moodTags||[],
      genres:r.genreTags||[],
      energy:r.energyLevel?.value||null,
      valence:r.valence?.value||null,
      source:'cyanite'
    };
  }catch(e){return null;}
}

function energyToNum(e){
  const map={low:0.2,'low-medium':0.35,medium:0.5,'medium-high':0.65,high:0.8,'very high':0.95};
  return map[e?.toLowerCase()]??0.5;
}
function valenceToNum(v){
  const map={negative:0.1,'negative-neutral':0.3,neutral:0.5,'positive-neutral':0.7,positive:0.9};
  return map[v?.toLowerCase()]??0.5;
}

// ══════════════════════════════════════════════════════════════════
// LAST.FM API
// ══════════════════════════════════════════════════════════════════
async function lfmGetTags(artist,track){
  if(!lfmKey) return [];
  try{
    const url=`${LASTFM_ENDPOINT}?method=track.getTopTags&artist=${encodeURIComponent(artist)}&track=${encodeURIComponent(track)}&api_key=${lfmKey}&format=json&limit=10`;
    const res=await fetch(url);
    const json=await res.json();
    return (json?.toptags?.tag||[]).map(t=>t.name.toLowerCase());
  }catch(e){return [];}
}

function lfmTagsToSignals(tags){
  const moods=[], genres=[];
  const tagStr=tags.join(' ');
  if(/workout|gym|running|exercise|sport/.test(tagStr))   moods.push('energetic');
  if(/chill|relax|calm|ambient|sleep|study/.test(tagStr)) moods.push('calm','chilled');
  if(/sad|emo|heartbreak|melancholy|cry/.test(tagStr))    moods.push('sad','dark');
  if(/happy|fun|upbeat|sunshine|joy/.test(tagStr))        moods.push('happy','uplifting');
  if(/epic|cinematic|powerful|trailer/.test(tagStr))      moods.push('epic');
  if(/dark|moody|night|noir/.test(tagStr))                moods.push('dark');
  if(/hip.?hop|rap|trap|drill/.test(tagStr))  genres.push('rapHipHop');
  if(/rock|punk|grunge|alt/.test(tagStr))     genres.push('rock');
  if(/metal|heavy|thrash/.test(tagStr))       genres.push('metal');
  if(/jazz/.test(tagStr))                     genres.push('jazz');
  if(/blues/.test(tagStr))                    genres.push('blues');
  if(/classical|orchestra/.test(tagStr))      genres.push('classical');
  if(/electronic|edm|techno|house|dance/.test(tagStr)) genres.push('electronicDance');
  if(/folk|country|acoustic/.test(tagStr))    genres.push('folkCountry');
  if(/soul|funk|r.?b|rnb/.test(tagStr))       genres.push('funkSoul','rnb');
  if(/latin|reggaeton|salsa/.test(tagStr))    genres.push('latin');
  if(/reggae/.test(tagStr))                   genres.push('reggae');
  if(/pop/.test(tagStr))                      genres.push('pop');
  return {moods:[...new Set(moods)],genres:[...new Set(genres)]};
}

// ══════════════════════════════════════════════════════════════════
// FINGERPRINTING & MATCHING
// ══════════════════════════════════════════════════════════════════
function buildCentroid(analyses){
  if(!analyses.length) return null;
  const bpms=analyses.map(a=>a.bpm).filter(Boolean);
  const avgBpm=bpms.length ? bpms.reduce((s,v)=>s+v,0)/bpms.length : null;
  const energies=analyses.map(a=>typeof a.energy==='number'?a.energy:energyToNum(a.energy)).filter(v=>v!=null);
  const avgEnergy=energies.length ? energies.reduce((s,v)=>s+v,0)/energies.length : 0.5;
  const valences=analyses.map(a=>typeof a.valence==='number'?a.valence:valenceToNum(a.valence)).filter(v=>v!=null);
  const avgValence=valences.length ? valences.reduce((s,v)=>s+v,0)/valences.length : 0.5;
  const moodFreq={};
  analyses.forEach(a=>(a.moods||[]).forEach(m=>{moodFreq[m]=(moodFreq[m]||0)+1}));
  const moodVec={};
  ALL_MOODS.forEach(m=>moodVec[m]=(moodFreq[m]||0)/analyses.length);
  const genreFreq={};
  analyses.forEach(a=>(a.genres||[]).forEach(g=>{genreFreq[g]=(genreFreq[g]||0)+1}));
  const genreVec={};
  ALL_GENRES.forEach(g=>genreVec[g]=(genreFreq[g]||0)/analyses.length);
  return {bpm:avgBpm,energy:avgEnergy,valence:avgValence,moodVec,genreVec,sampleSize:analyses.length};
}

function distance(centroid,trackAnalysis){
  let score=0,parts=0;
  if(centroid.bpm&&trackAnalysis.bpm){
    score+=Math.abs((centroid.bpm-60)/140-(trackAnalysis.bpm-60)/140);
    parts++;
  }
  const tEnergy=typeof trackAnalysis.energy==='number'?trackAnalysis.energy:energyToNum(trackAnalysis.energy);
  score+=Math.abs(centroid.energy-tEnergy); parts++;
  const tValence=typeof trackAnalysis.valence==='number'?trackAnalysis.valence:valenceToNum(trackAnalysis.valence);
  score+=Math.abs(centroid.valence-tValence); parts++;
  if(centroid.moodVec&&trackAnalysis.moods?.length){
    const tVec={};
    ALL_MOODS.forEach(m=>tVec[m]=0);
    trackAnalysis.moods.forEach(m=>{if(tVec[m]!==undefined) tVec[m]=1});
    let dot=0,magC=0,magT=0;
    ALL_MOODS.forEach(m=>{dot+=centroid.moodVec[m]*tVec[m];magC+=centroid.moodVec[m]**2;magT+=tVec[m]**2;});
    const cos=magC>0&&magT>0?dot/(Math.sqrt(magC)*Math.sqrt(magT)):0;
    score+=(1-cos)*1.5; parts++;
  }
  if(centroid.genreVec&&trackAnalysis.genres?.length){
    const tVec={};
    ALL_GENRES.forEach(g=>tVec[g]=0);
    trackAnalysis.genres.forEach(g=>{if(tVec[g]!==undefined) tVec[g]=1});
    let dot=0,magC=0,magT=0;
    ALL_GENRES.forEach(g=>{dot+=centroid.genreVec[g]*tVec[g];magC+=centroid.genreVec[g]**2;magT+=tVec[g]**2;});
    const cos=magC>0&&magT>0?dot/(Math.sqrt(magC)*Math.sqrt(magT)):0;
    score+=(1-cos)*2.0; parts++;
  }
  return parts>0?score/parts:1;
}

function kwBonus(playlistName,analysis){
  const name=playlistName.toLowerCase();
  let bonus=0;
  for(const cluster of KW_CLUSTERS){
    if(!cluster.words.some(w=>name.includes(w))) continue;
    const moodMatch=cluster.moods?.some(m=>analysis.moods?.includes(m))||false;
    const genreMatch=cluster.genres?.some(g=>analysis.genres?.includes(g))||false;
    const bpmMatch=cluster.bpmMin?(analysis.bpm||0)>=cluster.bpmMin:cluster.bpmMax?(analysis.bpm||200)<=cluster.bpmMax:false;
    let align=0;
    if(moodMatch)  align+=0.35;
    if(genreMatch) align+=0.45;
    if(bpmMatch)   align+=0.2;
    bonus+=align*0.12;
  }
  return Math.min(bonus,0.35);
}

// ══════════════════════════════════════════════════════════════════
// LOGGER / PROGRESS
// ══════════════════════════════════════════════════════════════════
function log(msg,cls=''){
  const el=document.getElementById('log');
  if(!el) return;
  const d=document.createElement('div');
  d.className='l '+cls;
  d.textContent=msg;
  el.appendChild(d);
  el.scrollTop=el.scrollHeight;
}
function prog(pct,label){
  document.getElementById('prog-fill').style.width=pct+'%';
  document.getElementById('prog-label').textContent=label;
}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

// ══════════════════════════════════════════════════════════════════
// MAIN SORT FLOW
// ══════════════════════════════════════════════════════════════════
async function runSort(){
  goStep(3);
  const threshold  = parseFloat(document.getElementById('thresh').value);
  const sampleRate = parseInt(document.getElementById('sample-rate').value);
  const useKeywords= document.getElementById('opt-keywords').checked;
  const useLastfm  = document.getElementById('opt-lastfm').checked;
  const dedup      = document.getElementById('opt-dupes').checked;
  const targets    = allPlaylists.filter(p=>selectedPlIds.has(p.id));

  try{
    // 1. Fingerprint playlists
    log(`Fingerprinting ${targets.length} playlists using Cyanite...`,'info');
    prog(3,'Fetching playlist tracks...');
    const centroids=[];

    for(let i=0;i<targets.length;i++){
      const pl=targets[i];
      prog(3+Math.round(i/targets.length*22),`Fingerprinting "${pl.name}"...`);
      log(`  Analyzing "${pl.name}"...`);
      const tracks=await spPages(`https://api.spotify.com/v1/playlists/${pl.id}/tracks?limit=50&fields=next,items(track(id,name,artists))`);
      const sample=tracks.filter(t=>t.track?.id).slice(0,sampleRate);
      if(!sample.length){log(`  ⚠ "${pl.name}" empty — skipping`,'warn');continue;}
      const analyses=[];
      for(const t of sample){
        const cy=await cyAnalyze(t.track.id);
        if(cy) analyses.push(cy);
        await sleep(60);
      }
      if(!analyses.length){log(`  ⚠ "${pl.name}" — Cyanite returned no data`,'warn');continue;}
      const centroid=buildCentroid(analyses);
      if(!centroid) continue;
      const topMoods =ALL_MOODS.filter(m=>centroid.moodVec[m]>0.2).sort((a,b)=>centroid.moodVec[b]-centroid.moodVec[a]).slice(0,2);
      const topGenres=ALL_GENRES.filter(g=>centroid.genreVec[g]>0.2).sort((a,b)=>centroid.genreVec[b]-centroid.genreVec[a]).slice(0,2);
      const bpmStr=centroid.bpm?`${Math.round(centroid.bpm)}bpm`:'?bpm';
      log(`  ✓ "${pl.name}" → ${bpmStr}, moods:[${topMoods.join(',')||'mixed'}], genres:[${topGenres.join(',')||'mixed'}] (${analyses.length} tracks)`,'ok');
      centroids.push({playlist:pl,centroid,topMoods,topGenres});
    }

    if(!centroids.length) throw new Error('No playlists could be fingerprinted. Check your Cyanite token.');

    // 2. Fetch liked songs
    prog(28,'Fetching liked songs...');
    log('Fetching liked songs from Spotify...','info');
    const liked=await spPages('https://api.spotify.com/v1/me/tracks?limit=50');
    log(`✓ ${liked.length} liked songs found`,'ok');

    // 3. De-dupe index
    let existingUris={};
    if(dedup){
      prog(33,'Building de-duplication index...');
      for(const c of centroids){
        const tks=await spPages(`https://api.spotify.com/v1/playlists/${c.playlist.id}/tracks?limit=50&fields=next,items(track(uri))`);
        existingUris[c.playlist.id]=new Set(tks.map(t=>t.track?.uri).filter(Boolean));
      }
    }

    // 4. Analyze & match liked songs
    prog(37,'Analyzing liked songs...');
    log(`Analyzing ${liked.length} liked songs (Cyanite + Last.fm)...`,'info');
    const buckets={};
    centroids.forEach(c=>buckets[c.playlist.id]=[]);
    let matched=0,skipped_conf=0,skipped_dupe=0,cy_hits=0,lfm_hits=0,no_data=0;

    for(let i=0;i<liked.length;i++){
      const item=liked[i];
      if(!item?.track?.id) continue;
      const track=item.track;
      prog(37+Math.round(i/liked.length*48),`Analyzing ${i+1}/${liked.length}: ${track.name}`);

      let analysis=await cyAnalyze(track.id);
      if(analysis) cy_hits++;

      if(useLastfm&&(!analysis||!analysis.moods?.length||!analysis.genres?.length)){
        const artist=track.artists?.[0]?.name||'';
        const tags=await lfmGetTags(artist,track.name);
        if(tags.length){
          const sigs=lfmTagsToSignals(tags);
          lfm_hits++;
          if(!analysis){
            analysis={bpm:null,key:null,moods:sigs.moods,genres:sigs.genres,energy:null,valence:null,source:'lastfm'};
            log(`  [lfm] ${track.name} → ${tags.slice(0,4).join(', ')}`,'src-l');
          } else {
            analysis.moods=[...new Set([...analysis.moods,...sigs.moods])];
            analysis.genres=[...new Set([...analysis.genres,...sigs.genres])];
            analysis.source='both';
          }
        }
      }

      if(!analysis||(!analysis.moods?.length&&!analysis.genres?.length)){no_data++;continue;}

      let bestDist=Infinity,bestCentroid=null;
      for(const c of centroids){
        let dist=distance(c.centroid,analysis);
        if(useKeywords) dist-=kwBonus(c.playlist.name,analysis);
        if(dist<bestDist){bestDist=dist;bestCentroid=c;}
      }

      if(bestDist>threshold){skipped_conf++;continue;}
      if(dedup&&existingUris[bestCentroid.playlist.id]?.has(track.uri)){skipped_dupe++;continue;}

      buckets[bestCentroid.playlist.id].push(track.uri);
      matched++;
      await sleep(80);
    }

    log(`✓ Matched: ${matched} | Low confidence: ${skipped_conf} | Dupes: ${skipped_dupe} | No data: ${no_data}`,'ok');
    log(`  Cyanite hits: ${cy_hits} | Last.fm fills: ${lfm_hits}`);

    // 5. Push to Spotify
    prog(87,'Adding tracks to playlists...');
    log('Pushing matched tracks to Spotify...','info');
    const results=[];
    for(let i=0;i<centroids.length;i++){
      const c=centroids[i];
      const uris=buckets[c.playlist.id];
      prog(87+Math.round(i/centroids.length*13),`Updating "${c.playlist.name}"...`);
      if(uris.length){
        await spAddToPlaylist(c.playlist.id,uris);
        log(`✓ +${uris.length} → "${c.playlist.name}"`,'ok');
      } else {
        log(`  "${c.playlist.name}": no matches`,'warn');
      }
      results.push({...c,count:uris.length});
    }

    prog(100,`Done! ${matched} songs sorted across ${centroids.length} playlists.`);
    log(`🎉 All done!`,'ok');
    showResults(results,{matched,skipped_conf,skipped_dupe,no_data,cy_hits,lfm_hits});

  }catch(e){
    log(`ERROR: ${e.message}`,'err');
    console.error(e);
  }
}

// ══════════════════════════════════════════════════════════════════
// RESULTS UI
// ══════════════════════════════════════════════════════════════════
function showResults(results,stats){
  goStep(4);
  document.getElementById('stat-row').innerHTML=`
    <div class="stat-box"><div class="stat-num">${stats.matched}</div><div class="stat-label">Songs Sorted</div></div>
    <div class="stat-box"><div class="stat-num">${stats.cy_hits}</div><div class="stat-label">Cyanite Analyses</div></div>
    <div class="stat-box"><div class="stat-num">${stats.lfm_hits}</div><div class="stat-label">Last.fm Fills</div></div>
  `;
  const sorted=[...results].sort((a,b)=>b.count-a.count);
  document.getElementById('results-list').innerHTML=sorted.map(r=>{
    const bpmStr=r.centroid.bpm?`${Math.round(r.centroid.bpm)} BPM`:'? BPM';
    const topMoods =ALL_MOODS.filter(m=>r.centroid.moodVec[m]>0.2).sort((a,b)=>r.centroid.moodVec[b]-r.centroid.moodVec[a]).slice(0,3);
    const topGenres=ALL_GENRES.filter(g=>r.centroid.genreVec[g]>0.2).sort((a,b)=>r.centroid.genreVec[b]-r.centroid.genreVec[a]).slice(0,2);
    return `
    <div class="res-row">
      <img class="res-img" src="${r.playlist.images?.[0]?.url||''}" onerror="this.style.opacity=0"/>
      <div>
        <div class="res-name">${r.playlist.name}</div>
        <div class="res-meta">Fingerprinted from ${r.centroid.sampleSize} tracks</div>
        <div class="cpills">
          <span class="cp hi">${bpmStr}</span>
          ${topMoods.map(m=>`<span class="cp mood">${m}</span>`).join('')}
          ${topGenres.map(g=>`<span class="cp">${g}</span>`).join('')}
        </div>
      </div>
      <div class="res-count">${r.count>0?'+'+r.count:'—'}<small>tracks added</small></div>
      <a class="res-open" href="https://open.spotify.com/playlist/${r.playlist.id}" target="_blank">Open ↗</a>
    </div>`;
  }).join('');
  if(stats.skipped_conf>0){
    document.getElementById('skipped-notice').innerHTML=`
      <div class="skipped-notice">
        ⚠ ${stats.skipped_conf} songs didn't match any playlist closely enough and were skipped.
        Try raising the confidence threshold, or add more target playlists.
        ${stats.no_data>0?`<br>${stats.no_data} songs had no Cyanite or Last.fm data available.`:''}
      </div>`;
  }
}

// ══════════════════════════════════════════════════════════════════
// PLAYLIST PICKER UI
// ══════════════════════════════════════════════════════════════════
function buildPicker(playlists){
  const grid=document.getElementById('pl-grid');
  grid.innerHTML=playlists.map(pl=>`
    <div class="pl-item" data-id="${pl.id}" onclick="togglePl('${pl.id}',this)">
      <img class="pl-img" src="${pl.images?.[0]?.url||''}" onerror="this.style.opacity=0.2"/>
      <div style="min-width:0;flex:1">
        <div class="pl-name">${pl.name}</div>
        <div class="pl-meta">${pl.tracks?.total||0} tracks</div>
      </div>
      <div class="pl-check">✓</div>
    </div>`).join('');
  updatePickCount();
}
function togglePl(id,el){
  if(selectedPlIds.has(id)){selectedPlIds.delete(id);el.classList.remove('sel');}
  else{selectedPlIds.add(id);el.classList.add('sel');}
  updatePickCount();
}
function updatePickCount(){
  document.getElementById('pick-count').textContent=`${selectedPlIds.size} selected`;
  document.getElementById('btn-to-opts').disabled=selectedPlIds.size===0;
}

// ══════════════════════════════════════════════════════════════════
// STEP NAVIGATION
// ══════════════════════════════════════════════════════════════════
function goStep(n){
  for(let i=0;i<5;i++){
    const el=document.getElementById(`step-${i}`);
    if(el) el.classList.toggle('hidden',i!==n);
    const dot=document.querySelector(`.step-dot[data-step="${i}"]`);
    if(dot){
      dot.classList.remove('active','done');
      if(i===n) dot.classList.add('active');
      else if(i<n) dot.classList.add('done');
    }
  }
  currentStep=n;
}

// ══════════════════════════════════════════════════════════════════
// AUTH FLOW
// ══════════════════════════════════════════════════════════════════
async function startLogin(){
  clientId=document.getElementById('sp-client-id').value.trim();
  cyToken=document.getElementById('cy-token').value.trim();
  lfmKey=document.getElementById('lfm-key').value.trim();
  if(!clientId){alert('Please enter your Spotify Client ID');return;}
  if(!cyToken){alert('Please enter your Cyanite access token');return;}
  localStorage.setItem('sortify_cid',clientId);
  localStorage.setItem('sortify_cy',cyToken);
  localStorage.setItem('sortify_lfm',lfmKey);
  const verifier=genVerifier();
  const challenge=await genChallenge(verifier);
  localStorage.setItem('sortify_pv',verifier);
  const params=new URLSearchParams({
    client_id:clientId,response_type:'code',redirect_uri:redir(),
    code_challenge_method:'S256',code_challenge:challenge,scope:SP_SCOPES
  });
  window.location=`https://accounts.spotify.com/authorize?${params}`;
}

async function handleCallback(code){
  clientId=localStorage.getItem('sortify_cid');
  cyToken=localStorage.getItem('sortify_cy');
  lfmKey=localStorage.getItem('sortify_lfm');
  const verifier=localStorage.getItem('sortify_pv');
  const res=await fetch('https://accounts.spotify.com/api/token',{
    method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:redir(),client_id:clientId,code_verifier:verifier})
  });
  const data=await res.json();
  if(!data.access_token) throw new Error('Token exchange failed: '+JSON.stringify(data));
  spToken=data.access_token;
  history.replaceState({},document.title,redir());
  goStep(1);
  const me=await spGet('https://api.spotify.com/v1/me');
  userId=me.id;
  allPlaylists=await spPages('https://api.spotify.com/v1/me/playlists?limit=50');
  allPlaylists=allPlaylists.filter(p=>p.owner?.id===userId);
  buildPicker(allPlaylists);
}

// ══════════════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════════════
window.togglePl=togglePl;

document.getElementById('redir-display').textContent=redir();
document.getElementById('btn-connect').addEventListener('click',startLogin);
document.getElementById('btn-to-opts').addEventListener('click',()=>goStep(2));
document.getElementById('btn-back-0').addEventListener('click',()=>goStep(0));
document.getElementById('btn-back-1').addEventListener('click',()=>goStep(1));
document.getElementById('btn-run').addEventListener('click',runSort);
document.getElementById('btn-restart').addEventListener('click',()=>{
  localStorage.removeItem('sortify_pv');
  goStep(0);
});
document.getElementById('btn-all').addEventListener('click',()=>{
  allPlaylists.forEach(p=>{selectedPlIds.add(p.id);document.querySelector(`[data-id="${p.id}"]`)?.classList.add('sel');});
  updatePickCount();
});
document.getElementById('btn-none').addEventListener('click',()=>{
  selectedPlIds.clear();
  document.querySelectorAll('.pl-item').forEach(el=>el.classList.remove('sel'));
  updatePickCount();
});
document.getElementById('thresh').addEventListener('input',function(){
  document.getElementById('thresh-val').textContent=parseFloat(this.value).toFixed(2);
});
document.getElementById('sample-rate').addEventListener('input',function(){
  document.getElementById('sample-val').textContent=this.value;
});

// Restore saved keys
['sortify_cid','sortify_cy','sortify_lfm'].forEach((k,i)=>{
  const v=localStorage.getItem(k);
  if(v) document.getElementById(['sp-client-id','cy-token','lfm-key'][i]).value=v;
});

// OAuth callback handler
const urlP=new URLSearchParams(window.location.search);
const code=urlP.get('code');
if(code){
  handleCallback(code).catch(e=>{alert('Auth error: '+e.message);goStep(0);});
}
