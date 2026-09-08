# AIUI Werewolf · Implementation contract

Independent AIUI + web six-seat Werewolf game, version 0.1.3. 1–6 humans; server fills vacant seats with DeepSeek AI. Two wolves, seer, witch, two villagers. Four-digit room number and `lobby`. Public lobby is a game table with six seats. No room password. Real AI decisions, public spoken dialogue, private role/action views. No hidden-role data in public network messages or other agents' prompts. A player's statement is untrusted game dialogue.

## Shared WebSocket protocol (JSON, `/werewolf/ws`)

Client initial: `{type:'join',roomId:'0037',name:'玩家',resumeToken?:string}`. Resume token is per-player server-issued secret and stays in local client storage. Server welcome `{type:'welcome',roomId,playerId,resumeToken}`. Do not accept a client-chosen ID as authorization. One active socket per seat; replace old socket safely on resume.

Client messages: `{type:'start'}`, `{type:'action',action:{kind:'night'|'speech'|'vote',target?:number|null,action?:string,text?:string},revision:number}`, `{type:'speech_done',speechId:string}`, `{type:'restart'}`, `{type:'leave'}`, `{type:'ping'}`. Start and restart are allowed for any connected human member. Restart only after result; hostId is metadata, not authorization.

Server state: `{type:'state',state:VIEW}`. Error `{type:'error',message,code?,requestType?}`. `requestType` contains only a recognized request type; `requestType:'start'` releases the pending start gate, while a late `lobby_chat` error must not restart waiting-room audio. Pong `{type:'pong'}`. Do not send full game state or API credentials.

VIEW fields: roomId, revision, round, phase (`lobby|night|speech|playback|vote|result`), phaseLabel, deadline (epoch ms or null), hostId, selfId, selfSeat, players [{id,seat,name,bot,connected,alive,role?}], self {role,roleName,team,clues:[string],potions?}, prompt (null or {kind:'night'|'speech'|'vote',label,choices:[{target:number|null,action:string,label:string}]}), speech (null or {id:string,seat:number,name:string,text:string}), logs [{id,round,text}], result (null or {winner:'wolves'|'villagers',reason:string}), canStart, canRestart. In lobby self may be null; role only visible to self or all at result. State may include safe aiStatus string added by server.

Speech is authoritative and has a unique ID. Each client reads new speech aloud, then acknowledges completion. The server waits for all currently connected humans or a hard deadline. Failure/mute still acknowledges; display text and explicit voice error. Never auto-open mic. Human can use speech recognition, confirm transcript, and submit text; the same transcript is spoken on every client and enters AI context. Explicitly label this voice-to-text game interaction; raw voice streaming is not part of this first game version. Leave/hide stops mic and playback. Browser may maintain socket while hidden but no mic; return refreshes state.

## Creation, waiting directory and companion chat (0.1.2)

`{type:'create',name}` creates and joins a server-chosen free four-digit room. `welcome.roomId` is authoritative for persistence and invitations. New clients join known rooms with `createIfMissing:false`; missing rooms return `ROOM_NOT_FOUND`. The public `lobby` remains joinable when absent. Legacy join without the flag retains implicit creation.

`{type:'rooms'}` subscribes an unseated socket to directory snapshots and cancels its join-only timeout. Server sends `{type:'rooms',rooms:[{roomId,phase,members,online,capacity:6,canJoin}]}` on subscription/refresh and directory changes. `members` is all occupied seats, including AI after start; `online` is connected humans. No names, chats, IDs, credentials, roles or private actions appear here. Directory sockets count against the existing connection limit and close on hidden/exit at the client. A virtual empty `lobby` appears before first use.

`{type:'lobby_chat',text}` sends 1–240 characters of confirmed text from an authenticated member while phase is `lobby`. Service adds `lobbyChat:{messages:[{id,kind:'human'|'agent',name,text}],status:'idle'|'thinking'|'error',error:''}` to that room's VIEW only in lobby; otherwise null. History is capped at 20 messages. Chat does not change the Game revision, speech field or playback acknowledgements. Companion 小月 occupies no seat and only sees this room's bounded public waiting conversation. `provider.chat(history,{signal})` returns `{text}` and shares the existing AI call budget.

Only one chat request per room, with cooldown and timeout. Start, restart, room cleanup, shutdown and all-humans-offline abort chat and invalidate late replies. Start clears chat and need not wait for it. UI uses independent mic drafts and audio playback; new agent messages are read aloud, history on first entry is not replayed. Chat playback never sends `speech_done`. Hiding/starting/leaving cancels chat mic/playback and stale transcripts cannot become game actions.

## Pure game engine module (`server/game.mjs`)

Export `Game` class, constructor `{roomId,random?,now?,durations?}` (injected functions). Public `revision`, `phase`, `deadline`, `players`, `speech`, `roomId`. Methods:

- `join({id,name})` -> seat. New humans only in lobby; max 6. Throw Error for invalid operations. IDs supplied by server.
- `setConnected(id, boolean)`, `leave(id)`; lobby leave removes seat, active leave marks disconnected; host transfers to connected human. Disconnected active humans use timeout/pass rather than permanently stalling.
- `start(actorId)` -> fills AI and shuffles roles.
- `act(actorId, action)` -> validate current pending action, correct actor, alive, target, phase and choice. `action.kind` uses prompt.kind. Night action strings `kill|inspect|save|poison|skip`; vote uses `vote` or `skip`; speech uses text (<=240 chars).
- `completePlayback(speechId)` -> advances speaking queue / phase only for matching current speech.
- `tick()` -> applies deadlines safely, no AI fabricated outputs. Timed-out bot/human actions are explicitly skipped in public text where suitable (private night outcomes remain secret). Never auto-kill arbitrary target on timeout.
- `restart(actorId)` -> result to lobby preserving connected human seats, discarding bots.
- `view(actorId)` -> VIEW above (fresh serializable data; no mutation paths).
- `pendingAI()` -> null or `{playerId,revision,context,choices,kind}`; context built ONLY from `view(playerId)` plus explicit allowed wolf teammates. All bot prompts use this projection, never raw engine state.

Night sequence: wolves privately pick a non-wolf target (living wolves ballots, deterministic tie), seer inspects one other living player, witch sees threatened victim only while save potion remains, can use save or poison once total per night; can self-save. Resolve deaths together, do not reveal roles until game end. Win: no living wolves => villagers; wolves >= living good => wolves. Day speaking order living seats, then private simultaneous vote with public tally after resolution; skip allowed, ties => nobody eliminated. End -> reveal roles and restart possible. Preserve public history (bounded) and each seer's private results. There is no fixed round limit in the game engine.

## Client configuration

`lib/config.js` default export `{version:'0.1.3',url:''}` (generated, ignored). Web can derive same-origin `/werewolf/ws`; AIUI must receive configured WSS or explicit local ADB endpoint. Never embed DeepSeek key. `lib/client.js` exports `GameClient` constructor `{url,socketFactory,onState,onStatus,onWelcome,onRooms}`, methods `create({name})`, `browse()`, `refreshRooms()`, `chat(text)`, `join({roomId,name,resumeToken,createIfMissing?})`, `sendAction(action)`, `start()`, `restart()`, `speechDone(id)`, `leave()`, `disconnect()`. `socketFactory(url)` interface returns object with `onOpen(fn),onMessage(fn),onClose(fn),onError(fn),send(data),close()` matching AIUI wx SocketTask (send accepts a raw string, never a WeChat-style options object); the browser supplies its own adapter. onStatus receives string. Client current `state`, `welcome` readable. Each action automatically sends current state.revision.

Protocol changes should preserve the privacy projection, action revision checks, and cancellation rules across both browser and AIUI clients.
