/* Synchronized online multiplayer client. The server remains authoritative. */
(function(){
 'use strict';
 const $=id=>document.getElementById(id);
 const modal=$('modal-online'), entry=$('online-entry'), waiting=$('online-waiting'), game=$('online-game');
 let session=null, pollTimer=null, polling=false, pollFailures=0, serverOffsetMs=0, lastRevision=0, ready=false, busy=false, activeState=null, countdownTimer=null, messageTimer=null;
 const MAX_DURATION=180, MIN_DURATION=15, DURATION_STEP=15, MAX_ROUNDS=10, MIN_ROUNDS=1;
 let onlineSettings={duration:60,rounds:5};
 function renderOnlineSettings(){
  $('online-duration-value').textContent=onlineSettings.duration+'s';
  $('online-rounds-value').textContent=onlineSettings.rounds;
 }
 $('online-duration-minus').addEventListener('click',()=>{onlineSettings.duration=Math.max(MIN_DURATION,onlineSettings.duration-DURATION_STEP);renderOnlineSettings();});
 $('online-duration-plus').addEventListener('click',()=>{onlineSettings.duration=Math.min(MAX_DURATION,onlineSettings.duration+DURATION_STEP);renderOnlineSettings();});
 $('online-rounds-minus').addEventListener('click',()=>{onlineSettings.rounds=Math.max(MIN_ROUNDS,onlineSettings.rounds-1);renderOnlineSettings();});
 $('online-rounds-plus').addEventListener('click',()=>{onlineSettings.rounds=Math.min(MAX_ROUNDS,onlineSettings.rounds+1);renderOnlineSettings();});
 renderOnlineSettings();
 const apiUrl=()=>window.GTF_CONFIG&&window.GTF_CONFIG.API_URL;
 const pollMs=()=>Math.max(1200,Number(window.GTF_CONFIG&&window.GTF_CONFIG.POLL_INTERVAL_MS)||2000);
 function message(text,error){const el=$('online-error');if(messageTimer)clearTimeout(messageTimer);messageTimer=null;el.textContent=text||'';el.classList.toggle('is-error',!!error);if(text&&!error)messageTimer=setTimeout(()=>{if(el.textContent===text)message('');},2500);}
 function gameMessage(text,error){const el=$('online-game-status');el.textContent=text||'';el.classList.toggle('is-error',!!error);}
 function requestId(){return window.crypto&&crypto.randomUUID?crypto.randomUUID():String(Date.now())+'-'+Math.random().toString(36).slice(2);}
 async function request(action,data){
  const url=apiUrl();
  if(!url||url.indexOf('https://script.google.com/macros/s/')!==0)throw new Error('Add your deployed Google Apps Script Web App URL in config.js first.');
  const payload=Object.assign({action,requestId:requestId()},session||{},data||{});
  const controller=window.AbortController?new AbortController():null;
  const timeout=controller?setTimeout(()=>controller.abort(),30000):null;
  try{
   const response=await fetch(url,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify(payload),redirect:'follow',signal:controller?controller.signal:undefined,cache:'no-store'});
   if(!response.ok)throw new Error('Server returned HTTP '+response.status+'.');
   const result=await response.json();
   if(!result.ok)throw new Error(result.error&&result.error.message||'The request failed.');
   return result;
  }catch(e){if(e.name==='AbortError')throw new Error('The server took too long to respond. Please try again.');throw e;}
  finally{if(timeout)clearTimeout(timeout);}
 }
 function open(){modal.hidden=false;message('');if(session&&activeState){entry.hidden=true;render(activeState);schedulePoll(0);}else{entry.hidden=false;waiting.hidden=true;game.hidden=true;}}
 function stopPolling(){if(pollTimer)clearTimeout(pollTimer);pollTimer=null;}
 function stopCountdown(){if(countdownTimer)clearInterval(countdownTimer);countdownTimer=null;}
 function close(){modal.hidden=true;stopCountdown();$('modal-online-add-question').hidden=true;}
 $('btn-create-game').addEventListener('click',open);
 $('online-close').addEventListener('click',close);
 $('modal-online-add-question').querySelector('.modal-close').addEventListener('click',()=>{$('modal-online-add-question').hidden=true;});
 $('online-create').addEventListener('click',async()=>{
  if(busy)return;busy=true;$('online-create').disabled=true;
  try{message('Creating lobby…');const r=await request('createLobby',{name:$('online-name').value,character:$('online-character').value,duration:onlineSettings.duration,rounds:onlineSettings.rounds});session={code:r.code,playerId:r.playerId,sessionToken:r.sessionToken};enterWaiting(r.state);message('Lobby created. Share the code with your friends.');}
  catch(e){message(e.message,true);}finally{busy=false;$('online-create').disabled=false;}
 });
 $('online-join').addEventListener('click',async()=>{
  if(busy)return;busy=true;$('online-join').disabled=true;
  try{message('Joining lobby…');const r=await request('joinLobby',{code:$('online-code').value.trim().toUpperCase(),name:$('online-name').value,character:$('online-character').value});session={code:r.code,playerId:r.playerId,sessionToken:r.sessionToken};enterWaiting(r.state);message('You joined the lobby.');}
  catch(e){message(e.message,true);}finally{busy=false;$('online-join').disabled=false;}
 });
 function enterWaiting(state){entry.hidden=true;waiting.hidden=false;game.hidden=true;lastRevision=0;render(state);schedulePoll(0);}
 function render(state){
  if(!state||!session)return;
  const incomingRevision=Number(state.revision)||0;
  // Action responses and polls can resolve out of order. Never let an older
  // snapshot replace the newest state already rendered by this client.
  if(incomingRevision<lastRevision)return;
  activeState=state;lastRevision=Math.max(lastRevision,incomingRevision);
  if(Number.isFinite(Number(state.serverNow)))serverOffsetMs=Number(state.serverNow)-Date.now();
  // The X (quick-close) control is only safe pre-game, in the lobby/entry screens:
  // it hides the modal without telling the server you left. Once the game has
  // started (answering/voting/results) or finished (leaderboard), leaving must
  // go through LEAVE GAME / EXIT TO HOME so the server and other players know.
  $('online-close').hidden=(state.status==='playing'||state.status==='finished');
  if(state.status==='playing'||state.status==='finished'){
   // Lobby/copy success toasts should not remain over active gameplay; errors
   // remain visible so actionable feedback is never discarded.
   const notice=$('online-error');
   if(notice&&!notice.classList.contains('is-error')&&notice.textContent)message('');
  }
  if(state.status==='playing'||state.status==='finished'){
   waiting.hidden=true;game.hidden=false;renderGame(state);
  }else if(state.status==='waiting'){
   game.hidden=true;waiting.hidden=false;renderWaiting(state);
  }else{gameMessage('This lobby is no longer active.',true);}
 }
 function renderPlayers(state){
  const list=$('online-players');list.textContent='';
  state.players.forEach(p=>{
   const row=document.createElement('div');row.className='online-player';
   const img=document.createElement('img');img.src='assets/characters/char-'+p.character+'.png';img.alt='';
   const name=document.createElement('span');name.textContent=p.name+(p.host?' · HOST':'');
   const status=document.createElement('small');status.textContent=p.connected?'CONNECTED':'RECONNECTING';
   row.append(img,name,status);list.appendChild(row);
  });
 }
 function renderWaiting(s){
  $('online-lobby-code').textContent=s.code;
  const me=s.players.find(p=>p.id===session.playerId), host=s.hostId===session.playerId;
  $('online-start').hidden=!host;
  ready=!!(me&&me.ready);
  $('online-start').disabled=s.players.length<3||s.players.some(p=>!p.connected);
  $('online-status').textContent='Waiting for players · '+s.players.length+'/'+(window.GTF_CONFIG.MAX_PLAYERS||8)+' · Minimum 3 to start';
  renderPlayers(s);
 }
 function showOnlineStage(id){
  ['online-answer-stage','online-voting-stage','online-results-stage','online-finished'].forEach(key=>$(key).hidden=key!==id);
 }
 function avatarMarkup(player){
  const ring=document.createElement('div');ring.className='avatar-ring';
  const img=document.createElement('img');img.src='assets/characters/char-'+player.character+'.png';img.alt=player.character+' character';ring.appendChild(img);return ring;
 }
 function renderGame(s){
  const me=s.players.find(p=>p.id===session.playerId),host=s.hostId===session.playerId;
  $('online-round').textContent='Round '+s.round+' / '+(s.settings&&s.settings.rounds||5);
  $('online-answer-question').textContent=s.question||'';
  $('online-advance').hidden=!(host&&s.phase==='voting'&&s.deadlineAt&&(Date.now()+serverOffsetMs)>=s.deadlineAt);
  $('online-advance').textContent='CONTINUE';
  $('online-play-again').hidden=!(host&&s.phase==='finished');
  // The leaderboard screen already has its own EXIT TO HOME button, so the
  // footer's LEAVE GAME control would be a redundant second way to do the same thing.
  $('online-game-leave').hidden=(s.phase==='finished');
  // Custom questions mirror Local Mode: only allowed when the game is set for 2+ rounds.
  const customAllowed=s.customQuestionsAllowed!==false;
  $('online-add-question').hidden=!customAllowed;
  $('online-add-question-locked-hint').hidden=customAllowed;
  $('online-answer-form').hidden=true;$('online-wait-answer').hidden=true;$('online-answer-card').textContent='';
  $('online-vote-form').hidden=true;$('online-wait-vote').hidden=true;$('online-answer-results').hidden=true;
  $('online-results-score-grid').textContent='';
  $('online-game-status').textContent='';
  if(s.phase!=='voting')stopCountdown();
  if(s.phase==='answering'){
   showOnlineStage('online-answer-stage');
   $('online-answer-progress-count').textContent=(s.answeredCount||0)+' / '+s.players.length+' Players Answered';
   $('online-answer-progress-fill').style.width=Math.min(100,((s.answeredCount||0)/Math.max(1,s.players.length))*100)+'%';
   if(me){$('online-answer-avatar').replaceChildren(avatarMarkup(me).querySelector('img'));$('online-answer-turn').textContent="It's "+me.name+"'s Turn";}
   if(s.myAnswerSubmitted){$('online-wait-answer').hidden=false;gameMessage('Your answer is submitted. Waiting for everyone else…');}
   else{$('online-answer-form').hidden=false;gameMessage('');}
  }else if(s.phase==='voting'){
   showOnlineStage('online-voting-stage');
   const answer=(s.answers||[])[0];if(answer)$('online-answer-card').textContent=answer.text||'Answer unavailable';
   const isAuthor=s.myIsAnswerAuthor===true,isMyTurn=s.myVotingTurn===true&&!s.myVoteSubmitted;
   if(me){$('online-voter-avatar').replaceChildren(avatarMarkup(me).querySelector('img'));$('online-voter-turn').textContent=isMyTurn?"It's "+me.name+"'s Turn to Guess":isAuthor?"It's "+me.name+"'s answer":'Waiting for your turn to guess';}
   if(isAuthor){stopCountdown();$('online-wait-vote').hidden=false;$('online-wait-vote').className='online-wait is-author-wait';$('online-wait-vote').textContent="That's your answer, don't get caught!";gameMessage('');}
   else if(!isMyTurn){stopCountdown();$('online-wait-vote').hidden=false;$('online-wait-vote').className='online-wait is-turn-wait';$('online-wait-vote').textContent='Waiting for another player to finish voting…';gameMessage('Waiting for another player to finish voting. Your timer has not started.');}
   else{$('online-wait-vote').className='online-wait';renderVoteChoices(s);$('online-vote-form').hidden=false;updateDeadline(s);}
  }else if(s.phase==='results'){
   showOnlineStage('online-results-stage');
   const hasResults=renderRoundResults(s);
   if(hasResults){renderResultsScoreGrid(s);updateResultsCountdown(s);}
   else{stopCountdown();gameMessage('Preparing voting results…');schedulePoll(500);}
  }else if(s.phase==='finished'){
   showOnlineStage('online-finished');gameMessage('All rounds are complete.');renderFinalResults(s);renderScoreboard(s);
  }
 }
 function renderRoundResults(s){
  const panel=$('online-answer-results'),r=s.roundResults;panel.textContent='';panel.hidden=!r;
  if(!r||!Array.isArray(r.answers)||!r.answers.length)return false;
  r.answers.forEach(a=>{
   const entry=document.createElement('div');entry.className='result-entry';
   const head=document.createElement('div');head.className='result-entry-head';
   const avatar=document.createElement('span');avatar.className='result-entry-avatar';
   if(a.authorCharacter){const img=document.createElement('img');img.src='assets/characters/char-'+a.authorCharacter+'.png';img.alt='';avatar.appendChild(img);}
   const name=document.createElement('span');name.className='result-entry-name';name.textContent=a.authorName||'Player';head.append(avatar,name);
   const answer=document.createElement('div');answer.className='result-entry-answer';answer.textContent='"'+(a.text||'')+'"';
   const correct=(a.votes||[]).filter(v=>v.correct).map(v=>v.voterName);
   const guessers=document.createElement('div');guessers.className='result-entry-guessers';guessers.textContent=correct.length?'Correctly guessed by: '+correct.join(', '):'Nobody guessed correctly!';
   entry.append(head,answer,guessers);panel.appendChild(entry);
  });return true;
 }
 function renderResultsScoreGrid(s){
  const grid=$('online-results-score-grid');grid.textContent='';
  (s.players||[]).forEach(p=>{
   const cell=document.createElement('div');cell.className='player-cell';
   const wrap=document.createElement('div');wrap.className='player-avatar-wrap';const avatar=document.createElement('div');avatar.className='player-avatar';
   const img=document.createElement('img');img.src='assets/characters/char-'+p.character+'.png';img.alt='';avatar.appendChild(img);wrap.appendChild(avatar);
   const name=document.createElement('div');name.className='player-name';name.textContent=p.name+' ('+(p.score||0)+')';cell.append(wrap,name);grid.appendChild(cell);
  });
 }
 function updateResultsCountdown(s){
  stopCountdown();if(modal.hidden||s.phase!=='results')return;
  if(!s.deadlineAt){gameMessage('Voting results are ready. Synchronizing the next phase…');schedulePoll(1000);return;}
  const label=s.round>=(s.settings&&s.settings.rounds||5)?'Leaderboard':'Next round';
  const tick=()=>{const left=Math.max(0,Math.ceil((s.deadlineAt-(Date.now()+serverOffsetMs))/1000));gameMessage(label+' in '+left+'s…');};
  tick();countdownTimer=setInterval(tick,1000);
 }
 function renderFinalResults(s){
  const panel=$('online-answer-results'),rounds=Array.isArray(s.finalResults)?s.finalResults:[];
  panel.textContent='';panel.hidden=true;
  // Keep the final screen focused on the same podium and ranked list as Local Mode.
 }
 function renderVoteChoices(s){
  const wrap=$('online-vote-players');wrap.textContent='';
  const me=session&&session.playerId;
  s.players.filter(p=>p.id!==me).forEach(p=>{
   const btn=document.createElement('button');btn.type='button';btn.className='player-cell';
   const avatarWrap=document.createElement('div');avatarWrap.className='player-avatar-wrap';const avatar=document.createElement('div');avatar.className='player-avatar';const img=document.createElement('img');img.src='assets/characters/char-'+p.character+'.png';img.alt='';avatar.appendChild(img);avatarWrap.appendChild(avatar);const label=document.createElement('div');label.className='player-name';label.textContent=p.name;btn.append(avatarWrap,label);btn.disabled=busy;
   btn.setAttribute('aria-label','Vote for '+p.name);
   btn.setAttribute('data-vote-target',String(p.id));
   btn.style.webkitTapHighlightColor='transparent';
   let activationLock=false;
   const submitVote=async()=>{
    if(activationLock||busy||p.id===me)return;
    activationLock=true;
    busy=true;
    Array.from(wrap.querySelectorAll('button')).forEach(b=>b.disabled=true);
    btn.classList.add('is-selected');
    try{
     const answer=(activeState.answers||[])[0];
     if(!answer)throw new Error('The active answer is unavailable.');
     const r=await request('submitVote',{answerId:answer.id,targetId:p.id});
     render(r.state);
    }catch(e){
     gameMessage(e.message,true);
     schedulePoll(0);
     Array.from(wrap.querySelectorAll('button')).forEach(b=>b.disabled=false);
    }finally{
     busy=false;
     activationLock=false;
     if(activeState&&activeState.phase==='voting'&&activeState.myVotingTurn===true&&!activeState.myVoteSubmitted){
      Array.from(wrap.querySelectorAll('button')).forEach(b=>b.disabled=false);
     }
    }
   };
   // Use pointerup for touchscreens. Native click can be unreliable when the
   // modal is scrolled on some mobile browsers; keyboard activation remains supported.
   btn.addEventListener('pointerup',e=>{
    if(e.pointerType==='touch'||e.pointerType==='pen'||e.pointerType==='mouse'){
     e.preventDefault();
     submitVote();
    }
   });
   btn.addEventListener('keydown',e=>{
    if(e.key==='Enter'||e.key===' '){e.preventDefault();submitVote();}
   });
   wrap.appendChild(btn);
  });
 }
 function renderScoreboard(s){
  const wrap=$('online-scoreboard'),podium=$('online-podium');wrap.textContent='';podium.textContent='';
  const ranked=s.players.slice().sort((a,b)=>(b.score||0)-(a.score||0));
  const podiumPlayers=ranked.slice(0,3),visualOrder=[1,0,2];
  visualOrder.forEach(index=>{
   const p=podiumPlayers[index];if(!p)return;const place=index+1;
   const col=document.createElement('div');col.className='podium-col podium-place-'+place;
   const ring=avatarMarkup(p);const name=document.createElement('div');name.className='player-name';name.textContent=p.name;
   const stand=document.createElement('div');stand.className='podium-stand';stand.append(document.createTextNode(String(place)));
   const pts=document.createElement('span');pts.className='podium-score';pts.textContent=(p.score||0)+' pts';stand.appendChild(pts);col.append(ring,name,stand);podium.appendChild(col);
  });
  let previousScore=null,rank=0;
  ranked.forEach((p,i)=>{
   if(previousScore===null||p.score!==previousScore)rank=i+1;previousScore=p.score;
   const row=document.createElement('div');row.className='leaderboard-row';
   const place=document.createElement('span');place.className='lb-rank';place.textContent='#'+rank;
   const avatar=document.createElement('span');avatar.className='player-avatar-wrap small-avatar';const face=document.createElement('span');face.className='player-avatar';const img=document.createElement('img');img.src='assets/characters/char-'+p.character+'.png';img.alt='';face.appendChild(img);avatar.appendChild(face);
   const name=document.createElement('span');name.className='lb-name';name.textContent=p.name;
   const score=document.createElement('span');score.className='lb-score';score.textContent=(p.score||0)+' pts';row.append(place,avatar,name,score);wrap.appendChild(row);
  });
 }
 function updateDeadline(s){
  stopCountdown();if(modal.hidden||document.hidden||s.phase!=='voting'||s.myVotingTurn!==true||s.myVoteSubmitted||!s.deadlineAt)return;
  const tick=()=>{const left=Math.max(0,Math.ceil((s.deadlineAt-(Date.now()+serverOffsetMs))/1000));$('online-vote-timer').textContent=Math.floor(left/60)+':'+String(left%60).padStart(2,'0');gameMessage('Voting closes in '+left+'s · '+(s.voteCount||0)+' vote(s) received');$('online-advance').hidden=!(s.hostId===session.playerId&&left===0);};
  tick();countdownTimer=setInterval(tick,1000);
 }
 function schedulePoll(delay){stopPolling();pollTimer=setTimeout(poll,delay);}
 async function poll(){
  if(!session||polling)return;polling=true;
  try{
   // One heartbeat request supplies the latest state and refreshes the reconnect lease.
   const r=await request('heartbeat');
   if(r.state&&Number.isFinite(Number(r.state.serverNow)))serverOffsetMs=Number(r.state.serverNow)-Date.now();
   pollFailures=0;
   if(r.revision>lastRevision||!activeState)render(r.state);
   schedulePoll(document.hidden?10000:pollMs());
  }catch(e){
   pollFailures=Math.min(pollFailures+1,5);
   gameMessage('Reconnecting… '+e.message,true);
   schedulePoll(Math.min(30000,2000*Math.pow(2,pollFailures-1)));
  }
  finally{polling=false;}
 }
 $('online-start').addEventListener('click',async()=>{
  if(busy)return;busy=true;$('online-start').disabled=true;$('online-start').textContent='STARTING…';
  try{const r=await request('startGame',{question:'What is something your friends might not know about you?'});render(r.state);}
  catch(e){message(e.message,true);if(activeState&&activeState.status==='waiting')renderWaiting(activeState);}
  finally{$('online-start').textContent='START GAME';busy=false;if(activeState&&activeState.status==='waiting')$('online-start').disabled=activeState.players.length<3||activeState.players.some(p=>!p.connected);}
 });
 $('online-answer').addEventListener('input',()=>{$('online-answer-count').textContent=$('online-answer').value.length+' characters';});
 $('online-exit-home').addEventListener('click',leave);
 $('online-submit-answer').addEventListener('click',async()=>{
  if(busy)return;const value=$('online-answer').value.trim();if(!value){gameMessage('Please type an answer first.',true);return;}
  busy=true;$('online-submit-answer').disabled=true;
  try{const r=await request('submitAnswer',{answer:value});$('online-answer').value='';render(r.state);}
  catch(e){gameMessage(e.message,true);}
  finally{busy=false;$('online-submit-answer').disabled=false;}
 });
 $('online-advance').addEventListener('click',async()=>{if(busy)return;busy=true;try{const r=await request('advancePhase');render(r.state);}catch(e){gameMessage(e.message,true);}finally{busy=false;}});
 $('online-play-again').addEventListener('click',async()=>{if(busy)return;busy=true;try{const r=await request('playAgain');render(r.state);}catch(e){gameMessage(e.message,true);}finally{busy=false;}});
 $('online-copy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('online-lobby-code').textContent);message('Lobby code copied.');}catch(e){message('Copy unavailable. Select the code to copy it.');}});
 async function leave(){stopPolling();stopCountdown();try{await request('leaveLobby');}catch(e){}session=null;activeState=null;pollFailures=0;close();entry.hidden=false;waiting.hidden=true;game.hidden=true;$('online-close').hidden=false;}
 $('online-leave').addEventListener('click',leave);$('online-game-leave').addEventListener('click',leave);

 /* ---------- ONLINE CUSTOM QUESTIONS (mirrors Local Mode; 2+ rounds only) ---------- */
 function updateOnlineCustomCount(){
  const max=(activeState&&activeState.maxCustomQuestions)||10;
  const count=(activeState&&activeState.customQuestionCount)||0;
  $('online-custom-question-count').textContent=count+' / '+max+' custom questions';
  $('online-save-question').disabled=count>=max;
 }
 $('online-add-question').addEventListener('click',()=>{
  if(!(activeState&&activeState.customQuestionsAllowed))return; // Guards a stale/disabled button.
  $('online-custom-question-input').value='';
  $('online-add-question-error').textContent='';
  updateOnlineCustomCount();
  $('modal-online-add-question').hidden=false;
 });
 $('online-save-question').addEventListener('click',async()=>{
  if(busy)return;
  if(!(activeState&&activeState.customQuestionsAllowed))return; // Prevents a direct trigger from bypassing the restriction.
  const text=$('online-custom-question-input').value.trim();
  if(!text)return;
  busy=true;$('online-save-question').disabled=true;
  try{
   const r=await request('submitCustomQuestion',{question:text});
   render(r.state);
   $('online-custom-question-input').value='';
   $('online-add-question-error').textContent='';
   updateOnlineCustomCount();
  }catch(e){$('online-add-question-error').textContent=e.message;}
  finally{busy=false;updateOnlineCustomCount();}
 });
 document.addEventListener('visibilitychange',()=>{if(document.hidden)stopCountdown();else if(session){schedulePoll(0);if(!modal.hidden&&activeState&&activeState.phase==='voting')updateDeadline(activeState);else if(!modal.hidden&&activeState&&activeState.phase==='results')updateResultsCountdown(activeState);}});
 window.addEventListener('beforeunload',()=>{stopPolling();stopCountdown();});
})();
