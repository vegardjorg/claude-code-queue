#!/usr/bin/env node
// =============================================================
// ko.mjs: arbeidskøen for kontinuerlig parallelt arbeid med Claude Code-agenter.
//
// Køen ligger i <dataMappe>/ko.json (standard scripts/.ko/, gitignorert), så den overlever at orkestratorens samtale
// komprimeres eller startes på nytt. Alle som har Bash (orkestratoren, planleggere, reviewere, spor) kan legge inn
// arbeid. Skriving skjer under en fillås (mkdir er atomisk) og via midlertidig fil + rename, så to samtidige skrivere
// ikke ødelegger fila. Logikken (hva kan startes, prioritet, grenser) er i lib/koLogikk.js; prosjektets innstillinger
// (basegren, grenprefiks, gater, migrasjoner, arkitekturregler) står i ko.config.json (lib/koKonfig.js).
// Køen og kommandoene er beskrevet i docs/queue.md, orkestratorløkka i docs/orchestration.md, sporenes protokoll i
// docs/mission-template.md og planregisteret i docs/plan-register.md.
//
// «Basegrenen» under er konfig().baseGren (integrasjonsgrenen alt flettes til), og køgrenene heter
// <grenPrefiks><id> (standard ko/<id>).
//
// Grunnleggende:
//   node scripts/orkestrator/ko.mjs init [--neste-migr <n>] [--maks-samtidig 5] [--maks-dpluss 2] [--maks-per-domene 7]
//        (lager datamappa og en tom kø med standardgrenser og eksempelprosjektet «eksempel»; rører aldri en
//         eksisterende kø. --neste-migr bare når migrasjonsflyten er slått på)
//   node scripts/orkestrator/ko.mjs add --fil oppgave.json        (ett objekt, en liste, eller { "oppgaver": [...],
//                                                                  "sporsmal": { "<id>": { type, tekst, … } } })
//   node scripts/orkestrator/ko.mjs add --json '{"id":"A-1",...}' [--godkjent]
//        Status: «forslag» når lagt_til_av er en agent (et spor/oppgave-id, reviewer eller utredningsagent), ellers
//        «venter». --godkjent (bare orkestratoren/eieren, f.eks. et alvorlig funn fra review) gir venter.
//   node scripts/orkestrator/ko.mjs godkjenn <id> [...]           (forslag → venter)
//   node scripts/orkestrator/ko.mjs vis                           (kort: aktive, startbare nå og tellinger)
//   node scripts/orkestrator/ko.mjs vis --full [--alle]           (tabell: status, klasse, anslag, prioritet, hindring;
//                                                                  forslagene for seg nederst; --alle/--gruppert/
//                                                                  --prosjekt gir også den fulle)
//   node scripts/orkestrator/ko.mjs neste                         (hva kan startes nå, uten å endre noe; exit 4 når
//                                                                  dagsbudsjettet er brukt opp, exit 5 ved nattpause)
//   node scripts/orkestrator/ko.mjs start <id> [--agent <navn>] [--tving]   (markerer kjorer, tildeler gren og ev.
//                                                                  migrasjonsblokk; --tving = eieren vil ha den først,
//                                                                  overstyrer også dagsbudsjettet og nattpausen)
//   node scripts/orkestrator/ko.mjs sett <id> <forslag|venter|kjorer|review|ferdig|kansellert> [--merknad "..."]
//   node scripts/orkestrator/ko.mjs endre <id> --json '{"nytte":8,"prioritet_tillegg":50}'
//   node scripts/orkestrator/ko.mjs tilstand                      (exit 3 når køen er tom for arbeid, også når
//                                                                  dagsbudsjettet eller nattpausen stopper nye oppgaver;
//                                                                  feltet stopp sier hvilken)
//   node scripts/orkestrator/ko.mjs sporfil <id> [...] --ut <fil> (sporblokker i lag-oppdrag.mjs-format; kjorer eller plukket)
//
// Eierspørsmål:
//   node scripts/orkestrator/ko.mjs avklar <spørsmål> [...] [--svar "…"] [--av "…"]   (eiersvaret er kommet: med
//                                                                  tidsstempel i `avklaringer`, svaret valgfritt; med
//                                                                  --svar får hver oppgave som venter på spørsmålet
//                                                                  tillegget «EIERSVAR <id> (<dato>): <svar>» i
//                                                                  oppdraget, én gang)
//   `venter_paa` tar BARE registrerte spørsmåls-id-er (bokstaver, tall, «.», «_», «-», høyst 40 tegn, ingen
//   mellomrom) med tekst og type i `sporsmal`. add og endre AVVISER (alt eller ingenting) en ny id som ikke er
//   registrert, med mindre add-fila registrerer den i { oppgaver, sporsmal }; fritekst stoppes. endre-mange og tavla
//   kan ikke endre venter_paa. fyll, vis og tilstand (feltet loseVentinger) varsler om løse ventinger: fritekst,
//   uregistrert, eller et besvart spørsmål som likevel blokkerer.
//   node scripts/orkestrator/ko.mjs avklaringer [--ulogget]       (svarene med tid; --ulogget: ikke ført i
//                                                                  beslutningsloggen ennå)
//   node scripts/orkestrator/ko.mjs avklaringer --merk-logget <spørsmål> [...]   (orkestratoren har ført dem)
//   node scripts/orkestrator/ko.mjs sporsmal                      (eierspørsmålene: tekst, type, åpne eller avklart)
//   node scripts/orkestrator/ko.mjs sporsmal <id> --tekst "…" [--type sporsmal|betingelse|jurist|eier-oppgave]
//        [--anbefaling "…"] [--kilde "…"]                          (setter ett; felt som ikke er med, beholdes)
//   node scripts/orkestrator/ko.mjs sporsmal --fil <json>         ({ "<id>": { type, tekst, anbefaling?, kilde? } };
//                                                                  alt eller ingenting)
//
// Grenser, kapasitet og vakter:
//   node scripts/orkestrator/ko.mjs grense [<navn> <verdi>]       (vis eller sett grenser: maksSamtidig, maksDPluss,
//                                                                  maksPerDomene, maksDb (heltall ≥ 0; maksDPluss høyst
//                                                                  maksSamtidig), dagsbudsjett <usd|av>,
//                                                                  nattkjoring <på|av>, nattvindu <HH-HH>,
//                                                                  autokompakt <på|av>, parallellTerskel <0-1>)
//   node scripts/orkestrator/ko.mjs kompakt [auto|manuell]        (vis eller sett komprimeringsmodusen for
//                                                                  orkestratorøkta, grenser.autokompakt; skriver hvilken
//                                                                  /autocompact-linje eieren limer inn)
//   node scripts/orkestrator/ko.mjs kapasitet [--json]            (ukekvoten: brukt siden siste nullstilling i
//                                                                  USD-ekvivalent og tokens, anslått %, tempo per døgn,
//                                                                  når kvoten er tom, og hvor mange spor samtidig som
//                                                                  varer til neste nullstilling; nullstillingsdag,
//                                                                  klokkeslett og plannavn står i konfig().kapasitet)
//   node scripts/orkestrator/ko.mjs kapasitet --kalibrer <prosent> [--tid <ISO>]   (prosenten Claude viser nå, eller
//                                                                  ved --tid: retter konstanten usd_per_100 i ko.json)
//   node scripts/orkestrator/ko.mjs kapasitet --modus varsel|tak|av   (fyll: bare varsel (standard), tak på nye spor
//                                                                  som overstyres med fyll --over-kvote, eller av)
//   node scripts/orkestrator/ko.mjs kapasitet --sett <usd_per_100>   (sett konstanten direkte)
//   node scripts/orkestrator/ko.mjs kapasitet --skykreditt <igjen_usd> [--total <usd>] [--utloper <ISO>]
//                                                                  (egen pott for skyøkter, settes for hånd)
//
// Lav parallellitet (logikken i lib/koDiagnose.js): går køen på færre agenter enn grenser.parallellTerskel (standard
// 0.7) av maksSamtidig, skriver `fyll` (etter linjene om hva som startes; de nystartede teller), `motta` og
// `orkestrator puls` et kort avsnitt «LAV PARALLELLITET: …», og `tilstand` har feltet `parallell`. Over terskelen
// skrives ingenting. Funntypene: avhenger-kansellert, avhenger-ukjent, dratt-med-pauset, lose-venting,
// venter-paa-avklart (rydding, bare i diagnose) og flaskehals. Diagnosen fikser aldri selv; hvert funn er «enkel»
// (mekanisk og entydig: ferdig kommando som orkestratoren kjører) eller «kompleks» (valg med anbefaling til eieren).
//   node scripts/orkestrator/ko.mjs diagnose [--json]             (hele diagnosen uansett parallellitet; leser bare)
//
// Orkestratorens rutine som skript og kost per oppgave (den rene logikken i lib/koLogikk.js):
//   node scripts/orkestrator/ko.mjs fyll --scratchpad <mappe> [--maks N] [--ider <id …>] [--over-kvote]
//        (neste → start → sporfil → lag-ko-felles → lag-oppdrag i ett kall. Skriver <mappe>/prompt-<id>.md og
//         <mappe>/ko-fyll.json [{ id, klasse, subagent_type, prompt, melding, gren, migr_blokk }], og én linje +
//         agentmeldingen per spor. Lagrer head_start (HEAD på basegrenen, --bolge-base til flett-spor) og scratchpad
//         på oppgaven. --ider: bare disse; en som allerede kjører, får bare nye prompt-filer (etter en feil).
//         KO_SCRATCHPAD kan stå i stedet for --scratchpad. Uten --ider skriver fyll en kvotelinje når prognosen
//         tømmer ukekvoten før nullstillingen; med kapasitet --modus tak startes høyst så mange nye, og --over-kvote
//         overstyrer.)
//   node scripts/orkestrator/ko.mjs motta <id> [--scratchpad <mappe>] [--resultat "RESULTAT …"] [--tving]
//        (sporet har levert: status review, og review-pakken som VANLIGE FILER i <mappe>/rev-<id>/: 00-pakke.md
//         (resultatlinja, ev. endrede DB-objekter, diff-statistikk), diff.patch, filer/ (endrede filer i full versjon
//         fra grenen), sporsvar.md (sporets siste svar fra transkriptet), sporrapport.md og overlevering.md (fra
//         <mappe>/<id>/), og reviewer-<type>.md (den korte prompten) per reviewer etter klasse (konfig().reviewere).
//         Lagrer RESULTAT-linja. Fletter IKKE; skriver flett-kommandoen.)
//   node scripts/orkestrator/ko.mjs sett <id> ferdig [--funn "FUNN H=0 M=1 L=3 …"] [--resultat "…"] [--uten-kost]
//        (måler kosten: agentene i tidsloggen som hører til oppgaven (spor-etiketten, retterunder, og reviewere uten
//         etikett når oppdraget deres nevner id-en), usage fra transkriptene; lagrer kost {usd, tokens, turer,
//         agenter} og funn {H, M, L, utsettbare, rapporter} fra reviewernes FUNN-linjer eller --funn (kan gjentas).
//         Feiler målingen, settes oppgaven ferdig likevel.)
//   node scripts/orkestrator/ko.mjs kost [--siden 7d|24t|2026-10-01] [--maks 10]   (statistikk per klasse: n, median
//                                                                  og sum USD, funn H/M/L; de siste oppgavene)
//   node scripts/orkestrator/ko.mjs kost maal <id> [...] [--funn "…"]   (måler og lagrer på nytt, f.eks. eldre ferdige)
//   Transkriptene: ~/.claude/projects/<repo-slug>/<økt>/subagents/agent-<id>.jsonl (KO_TRANSKRIPTER overstyrer).
//
// Færre orkestratorturer: `fyll` og `motta` slutter med «Start disse i SAMME tur:» og én linje per agent
// (subagent_type + melding); start dem i én tur. `motta` advarer når sporets svar er over rapporttaket (ca. 1 500 tegn).
//   node scripts/orkestrator/ko.mjs flett <id> [--uten-migr-push] [--uten-fyll] [--scratchpad <mappe>] [--tving]
//        (etter godkjent review; kjør fra Bash (flett-spor kaller sh), med lang timeout: gatene kan ta minutter. I ett
//         kall: flett-spor.mjs <gren> --bolge-base <head_start> → migrasjonssteget (bare når konfig().migrasjoner er
//         slått på og grenen har migrasjonsfiler: miljøvakta (miljoFil/tillatteMiljo) og push-vakta spørres, så
//         migrasjoner.pushKommando) → gater.mjs --rask → sett <id> ferdig (kostmåling) → fyll (med mindre
//         --uten-fyll). Stopper ved første feil med steg og feilutdrag; full logg i <scratchpad>/flett-<id>.log.
//         Exit 0 ok, 1 stopp.)
//   node scripts/orkestrator/ko.mjs info <id> [--felt <navn>] [--json]   (kort visning; ett felt rått, også kost.usd)
//   node scripts/orkestrator/ko.mjs endre <id> --tillegg "<tekst>"  (til oppdraget, i sporblokka fra neste
//                                                                  sporfil/fyll, og til merknadene, med tidsstempel)
//   node scripts/orkestrator/ko.mjs aktive                        (kjorer/plukket/review: id, klasse, gren, migr_blokk,
//                                                                  head_start, alder)
//   node scripts/orkestrator/ko.mjs neste-migr [<n>]              (bare med migrasjonsflyten: vis eller sett; nekter
//                                                                  bakover og ned i et brukt nummer: høyeste
//                                                                  migrasjonsfil eller tildelte blokk)
//   Test: KO_FLETT_KJORER=<modul> injiserer kjøreren i flett (ingen ekte fletting, push eller gater).
//
// Prosjekt, funksjon, plukking og visuell QA:
//   node scripts/orkestrator/ko.mjs prosjekter                    (per prosjekt: ferdig/totalt, min igjen, aktive/plukkede,
//                                                                  QA, pause, eierspørsmålene som blokkerer flest)
//   node scripts/orkestrator/ko.mjs prosjekt <pid> [--tittel ..] [--plan ..] [--prefiks A- B- …] [--pause | --fortsett]
//        [--prioritet N] [--omrade <oid|ingen>] [--filrot <sti …>] [--fase plan|ingen]
//        (oppretter eller endrer; --prefiks erstatter lista. --fase plan = finnes i planarbeidet, ingen køoppgaver
//         ennå; tas bort av seg selv når add gir prosjektet oppgaver)
//   node scripts/orkestrator/ko.mjs vis [--alle] [--prosjekt <pid>] [--gruppert]   (--gruppert: prosjekt → funksjon → oppgaver)
//   node scripts/orkestrator/ko.mjs plukkbare [--etikett visuell] [--prosjekt <pid>] [--maks-min N]
//   node scripts/orkestrator/ko.mjs plukk <id> --av "<hvem>" [--tving]   (person/økt gjør oppgaven: egen gren og ev.
//                                                                  migrasjonsblokk; teller ikke mot maksSamtidig/maksDPluss)
//   node scripts/orkestrator/ko.mjs lever <id>                    (plukket → review; orkestratoren fletter)
//   node scripts/orkestrator/ko.mjs slipp <id>                    (plukket → venter; advarer når grenen har commits)
//   node scripts/orkestrator/ko.mjs qa                            (QA-lista: ferdige med etiketten visuell som venter)
//   node scripts/orkestrator/ko.mjs qa ok <id> [...]              (bare eieren)
//   node scripts/orkestrator/ko.mjs qa avvik <id> "<tekst>"       (bare eieren; lager rettingsoppgaven <id>-QA<n>)
//   node scripts/orkestrator/ko.mjs endre-mange --fil <json> [--torr] [--forvent-endret <iso>] [--json] [--av "…"]
//        ([{ id, prosjekt?, funksjon?, etiketter?, krever?, prioritet_tillegg?, parkert?, samles?, plan? }] eller
//         { prosjekter: {…}, oppgaver: [...] }; alt eller ingenting. Se masseendring under.)
// Prosjekt for en oppgave: eksplisitt `prosjekt`, ellers prosjektet med den LENGSTE prefiksen som matcher id-en (lik
// lengde: det første i registeret), ellers «uten-prosjekt». `neste`/`start` hopper over pausede prosjekter (start
// --tving overstyrer) og legger prosjektets prioritet_tillegg til oppgavens prioritet.
//
// Arbeid utenfor køen (git-lesingen i lib/koGit.js, beslutningene i lib/koLogikk.js):
//   node scripts/orkestrator/ko.mjs ekstern [--siden <24t|3d|2026-09-30|sha>] [--alle] [--maks N] [--usporet] [--json]
//        (bare lesing: (a) commits på basegrenen som ikke er fletter av køgrener og mangler traileren
//         «Ko: orkestrator», med filer og oppgave-id-er de nevner; (b) grener/worktrees utenfor køgrenene med commits
//         som ikke er i basegrenen; (c) ucommittet i hovedtreet; kollisjoner med eierfilene. Standardvinduet er det
//         som ikke er pushet.)
//   node scripts/orkestrator/ko.mjs ekstern --id <id>             (bare én oppgave, siden den ble lagt inn)
//   node scripts/orkestrator/ko.mjs ekstern godta <id> <sha>     (ventende oppgave gjort utenfor køen → ferdig; aldri automatisk)
//   node scripts/orkestrator/ko.mjs ekstern add --navn "<økt eller person>" --filer <sti …> [--db <fn …>] [--gren <g>]
//        (rad med status ekstern som eier filene som en plukket oppgave; samme navn igjen legger til filer)
//   node scripts/orkestrator/ko.mjs ekstern ferdig "<navn>"      (filene er fri igjen)
//   `neste` og `start` hopper over oppgaver som eier en ucommittet fil i hovedtreet (start --tving overstyrer);
//   `start`, `plukk` og `sporfil` advarer når eierfilene er endret utenfor køen siden oppgaven ble lagt inn (sporfila
//   får advarselen, så sporet leser diffen). Push: scripts/orkestrator/push-sjekk.mjs.
// Orkestrator-markør (<dataMappe>/orkestrator.json, utløper etter 2 t uten oppdatering):
//   node scripts/orkestrator/ko.mjs orkestrator                    (er en orkestrator aktiv?)
//   node scripts/orkestrator/ko.mjs orkestrator puls [--okt "<navn>"]   (orkestratoren, hver løkkerunde; start og sett
//                                                                  for køens egne oppgaver gjør det selv; et NYTT
//                                                                  --okt-navn = ny økt (nødrotasjon), nullstiller
//                                                                  avviklingen; vanlig vei er komprimering)
//   node scripts/orkestrator/ko.mjs orkestrator stopp             (løkka er stoppet eller overlevert; fjerner også
//                                                                  avviklingsflagget)
//
// Sky: K/U-oppgaver uten migrasjoner og DB kan kjøres i en skyøkt på claude.ai (eieren limer inn pakka fra tavla, eller
// en rutine gjør det). Skyen ser bare det som er pushet; egnetheten står i koLogikk.skyEgnet.
//   node scripts/orkestrator/ko.mjs sky                            (skyøktene som går, og de ventende som er egnet)
//   node scripts/orkestrator/ko.mjs sky-pakke <id> [<id> …] [--ut <fil>] [--tving]   (selvstendig melding; stdout uten
//                                                                  --ut; nekter med grunnene når en oppgave ikke er egnet.
//                                                                  Flere id-er = bunt i én skyøkt: høyst 4, sum anslag
//                                                                  ≤ 120 min, egen gren/commit/push/rapportlinje per id)
//   node scripts/orkestrator/ko.mjs sky-bunter [--maks 4] [--maks-min 120]   (forslag: skyegnede gruppert etter
//                                                                  prosjekt/funksjon, etter prioritet)
//   node scripts/orkestrator/ko.mjs sky start <id> [<id> …] [--kjoring <økt-id|url>] [--tving]   (plukket av «sky»;
//                                                                  høyst 3 skyøkter, en bunt teller som én; igjen med
//                                                                  --kjoring setter bare kjøringen)
//   node scripts/orkestrator/ko.mjs sky ferdig <id> [--gren <gren>] [--sha <sha>]   (git fetch av grenen (standard
//                                                                  køgrenen), minst én commit over <remote>/<basegren>,
//                                                                  lokal køgren settes til den, så review; orkestratoren
//                                                                  fletter)
//   node scripts/orkestrator/ko.mjs sky avbryt <id>                (= slipp)
//   Tidsloggen får sky-start, sky-ferdig og sky-avbrutt.
//
// Samlekøen: små oppgaver som ikke passer naturlig inn i et spor av riktig størrelse (K 90–120 min innhold, D ca. 40,
// U ca. 60), og som ikke blokkerer noe, legges inn med "samles": true. De vises, men startes og plukkes aldri alene
// (heller ikke med --tving) og telles for seg i vis/tilstand. `add`/`endre` avviser samles for D+, for oppgaver andre
// åpne oppgaver avhenger av, og for oppgaver med åpne eierspørsmål; og at en oppgave avhenger av en i samlekøen.
// `endre <id> --json '{"samles":false}'` tar den ut igjen. Logikken: koLogikk.samle*.
// Småoppgavevakten: `add` avviser en oppgave med eksplisitt innhold_min under nedre mål for klassen når den ikke er D+,
// ikke blokkerer og ikke venter på eieren: <= 10 min skal fikses nå eller samles (eierens valg), over 10 min med
// nytte <= 7 skal samles, og uten nytte spørres eieren. `"eget_spor": "<grunn>"` overstyrer. Logikken:
// koLogikk.smaaoppgaveFeil.
//   node scripts/orkestrator/ko.mjs samle                          (gruppene prosjekt → klasse, funksjonene i dem og
//                                                                  felles filer, sum innholdsminutter mot målet; «KLAR
//                                                                  TIL PAKKING» fra nedre mål: K 90, D 30, U 45)
//   node scripts/orkestrator/ko.mjs samle pakk <id> <id> … --id <ny-id> [--tittel "…"] [--forvent-endret <iso>]
//        (ett nytt spor: samme klasse, aldri D+, like åpne eierspørsmål; innhold_min sum, nytte/migr_tiere maks,
//         avhenger union minus delene, eierskap/krever/etiketter union, prosjekt/funksjon felles eller første,
//         sammenslatt_fra; oppdragsfil <dataMappe>/oppdrag/<ny-id>.md med delenes oppdrag i sin helhet; delene
//         kansellert med merknad «slått sammen i <ny-id>»; avhenger i andre oppgaver pekt om. Alt eller ingenting.)
//   node scripts/orkestrator/ko.mjs samle pakk --auto [--utfor]   (forslag for de klare gruppene, med id <prefiks>S<n>;
//                                                                  --utfor pakker alle i én skriving)
//
// Områder, fokusperiode og parkering (logikken i lib/koLogikk.js). Alle felt er valgfrie; uten fokus og uten parkerte
// rangeres køen etter prioritet alene.
//   node scripts/orkestrator/ko.mjs omrade <oid> --tittel "…" [--beskrivelse "…"] [--prosjekter <pid> …] [--fjern <pid> …]
//        [--forvent-endret <iso>] [--json]
//        (oppretter/endrer et område og setter prosjektenes `omrade`; et prosjekt hører til ett område. --slett nekter
//         når et prosjekt eller fokuset bruker området.) Også: ko.mjs prosjekt <pid> --omrade <oid|ingen>.
//   node scripts/orkestrator/ko.mjs omrader                        (område → prosjekter, venter, klare, min igjen, parkert)
//   node scripts/orkestrator/ko.mjs fokus                          (gjeldende fokus, trinnene, dratt med, Neste opp, varsel)
//   node scripts/orkestrator/ko.mjs fokus sett <trinn> [<trinn> …] [--resten vent|fyll] [--til <dato>] [--navn "…"]
//        [--uten-avhengigheter] [--av "…"]
//        (trinn = omrade:<oid>, prosjekt:<pid>, funksjon:<pid>/<navn> eller et nakent område-/prosjektnavn. Alt i trinn 1
//         før alt i trinn 2, uansett poeng; innen et trinn gjelder score. Det mest spesifikke trinnet vinner.
//         --resten vent (standard): oppgaver utenfor fokus startes ikke; fyll: de fyller plasser fokuset ikke bruker.
//         Avhengigheter til fokusoppgaver dras med (transitivt) med mindre --uten-avhengigheter. --til YYYY-MM-DD = til
//         og med den dagen (UTC); etterpå rangeres køen som uten fokus, med varsel. Pause på et prosjekt går foran.)
//   node scripts/orkestrator/ko.mjs fokus av
//   node scripts/orkestrator/ko.mjs fokus lagre --fil <plan.json> [--torr] [--forvent-endret <iso>] [--json] [--av "…"]
//        (planvisningen på tavla: { rekkefolge, naa_antall?, resten?, til?, navn?, dra_med_avhengigheter?,
//         pause?: [pid], fortsett?: [pid] } i ÉN endring, alt eller ingenting. Tom rekkefølge = fokus av. naa_antall =
//         hvor mange trinn tavla viser i «Nå».)
//   node scripts/orkestrator/ko.mjs parker <id> … [--grunn "…"] [--til <dato>] [--av "…"]   (sett på vent: status forblir
//                                                                  venter; neste, start og plukkbare hopper over; plukk
//                                                                  og start krever --tving. Bare venter og forslag.)
//   node scripts/orkestrator/ko.mjs fortsett <id> …                (tar av vent)
//   Varsel når fokuset ikke har noe klart eller perioden er ute: i `neste`, `vis`, `fokus` og `tilstand` (feltet fokus).
//
// Masseendring, angre, blokkflytting og forslag til prosjekt. Alt skjer under låsen og er alt eller ingenting.
//   endre-mange: feltene `parkert` (true | { grunn?, til? } | null = ta av vent; bare venter og forslag, som parker) og
//        `samles` (true | false/null; samme regler som add/endre), og registerfeltene omrade, filrot og funksjoner.
//        --torr: forhåndsvisning (hva som endres, advarsler, køens versjon `endret`), skriver ingenting.
//        --forvent-endret <iso>: nekter med exit 6 når køen er endret etter det tidspunktet (tavla har forhåndsvist en
//        eldre kø). --json: svaret som JSON (til tavla).
//   node scripts/orkestrator/ko.mjs ranger <id> … --topp|--bunn|--over <id>|--under <id> [--torr] [--forvent-endret <iso>]
//        [--json]   (flytter oppgavene som en blokk innen fokustrinnet og beholder rekkefølgen innbyrdes; nye
//                    prioritet_tillegg. --json: svaret som JSON til tavla)
//   node scripts/orkestrator/ko.mjs angre [--vis] [--nr <n>] [--forvent-endret <iso>] [--json]
//        (ruller tilbake siste post i endringsloggen som ikke er angret; nekter når et felt er endret siden. --nr: bare
//         når den siste angrbare posten er nr. n, så tavlas «Angre» aldri ruller tilbake en annens endring.
//         Endringsloggen (`endringslogg`, de siste 50) føres av endre, endre-mange, ranger, parker, fortsett, prosjekt
//         og klassifiser.)
//   node scripts/orkestrator/ko.mjs klassifiser [--fil <inn.json>] [--uten-prosjekt] [--uenige] [--utfor] [--json]
//        (forslag til prosjekt: lengste prefiks, planen i kilde/oppdrag, filrot (`prosjekt <pid> --filrot <sti …>`).
//         Uten --fil: oppgavene i køen, «flytt» (sikre forslag for oppgaver uten prosjekt; --utfor setter dem) og
//         «Sorter» (usikre, eller uenige med prosjektet de har; endres aldri automatisk). --fil: forslag for en add-fil.)
//   `add` advarer når prosjekt mangler (med forslaget og signalet) eller strider mot sterke signaler, og om en funksjon
//   som ikke står i prosjektets `funksjoner`. `prosjekt` advarer om prefikser på ett tegn og overlappende prefikser.
//
// Planregisteret (logikken i lib/koPlan.js; se docs/plan-register.md). Registeret er <dataMappe>/planer.json, egen fil
// ved siden av ko.json (planarbeid bumper aldri køens versjon), med samme lås, atomiske skriving, --forvent-endret (mot
// planer.json), endringslogg og angre. Fila lages ved første skrivende plan-kommando. Modul = område (`ko.mjs omrade`),
// prosjekt = `ko.mjs prosjekt`; planposten peker til dokumentene, den kopierer dem ikke.
//   node scripts/orkestrator/ko.mjs plan vis [--modul m] [--prosjekt p] [--prioritet naa eier …] [--modenhet …]
//        [--sok "…"] [--alle] [--json]          (droppede skjules uten --alle eller --prioritet dropp)
//   node scripts/orkestrator/ko.mjs plan hent <id|prosjekt|modul> [--json]   (poster, kilder, køstatus, eierspørsmål
//                                                                             og kopier-linja)
//   node scripts/orkestrator/ko.mjs plan ny --fil <json> (én post eller en liste)
//   node scripts/orkestrator/ko.mjs plan endre <id> [--felt navn=verdi …] [--sett '{"felt":…}']   (null eller navn=
//        fjerner feltet)
//   node scripts/orkestrator/ko.mjs plan prioriter <id…> <naa|eier|senere|dropp> [--kategori sikkerhet for-prod viktig]
//        [--grunn "Regel 3: …"]   (alt eller ingenting; dropp krever --grunn)
//   node scripts/orkestrator/ko.mjs plan prioriter-mange --fil <json>   ([{ id, prioritet, kategori?, grunn? }], alle
//        flyttingene i én skriving: én lås og én endringslogg-post, alt eller ingenting)
//   node scripts/orkestrator/ko.mjs plan slaa-sammen <til-id> <fra-id…>     (de andre flyttes til arkivet)
//   node scripts/orkestrator/ko.mjs plan verifiser <id> --funn "…" [--commit <sha>]
//   node scripts/orkestrator/ko.mjs plan angre [--vis] [--nr <n>]
//   node scripts/orkestrator/ko.mjs plan regler [--json]                     (prioritetsreglene)
//   node scripts/orkestrator/ko.mjs plan aktiv [<id> [--slutt]] [--av "…"] [--json]   («Arbeider nå»-markøren
//        aktiv_okt { post, at, av } i planer.json; uten id listes de aktive. Ingen endringslogg, endret bumpes ikke,
//        og markøren dør etter 2 timer uten ny puls)
//   Skrivende plan-kommandoer tar --torr (forhåndsvisning), --forvent-endret <iso>, --json (svar som JSON), --av "…" og
//   --satt-av agent|eier (standard agent). En agent endrer aldri en prioritet eieren har satt, unntatt regel 1
//   (sikkerhet løfter til naa; feltet agent_loft viser det), og må alltid gi prioritet_grunn.
//   node scripts/orkestrator/ko.mjs add --fil <oppgave.json> --plan <PL-id>   (kobler oppgavene uten eget `plan` til
//        planposten; en ukjent eller sammenslått post nektes, prosjekt hentes fra posten når det mangler, og posten
//        blir i-ko av seg selv. Feltet `plan` kan også stå i fila, og settes på eksisterende oppgaver med endre-mange.)
//   node scripts/orkestrator/ko.mjs plan sjekk [--json] [--maks N]   (uregistrerte dokumenter, døde stier, foreldet,
//        statusavvik, regelavvik, hull, mulige duplikater og kapasitet; leser bare)
//   node scripts/orkestrator/ko.mjs plan moduler [--koble] [--torr] [--json]   (oppretter modulene fra
//        konfig().moduler som mangler i omrader; --koble gir prosjekter uten modul forslaget i
//        konfig().prosjektModulForslag)
//   node scripts/orkestrator/ko.mjs plan backup [--push] [--torr]   (kjører skriptet i konfig().planBackup, med
//        KO_ROT = prosjektrota; KO_PLAN_BACKUP overstyrer stien. Ikke satt opp = forklaring og exit 1)
// Dokumenter og avtaler: registeret `dokumenter` i planer.json (bare metadata; teksten ligger der den ligger), med
// samme lås, --forvent-endret, endringslogg og `plan angre` som planpostene.
//   node scripts/orkestrator/ko.mjs plan dok vis [--gruppe g …] [--status s …] [--malgruppe m …] [--prioritet p …]
//        [--problemer] [--sok "…"] [--alle] [--json]   («Hva må gjøres» øverst, så en tabell per gruppe)
//   node scripts/orkestrator/ko.mjs plan dok hent <DOK-id> [--json]   (versjonsglipp, neste revisjon, koblinger,
//        kopier-linja)
//   node scripts/orkestrator/ko.mjs plan dok ny --fil <json>            (ett dokument eller en liste)
//   node scripts/orkestrator/ko.mjs plan dok endre <DOK-id> [--felt navn=verdi …] [--sett '{…}']
//   node scripts/orkestrator/ko.mjs plan dok revider <DOK-id> [--versjon v] [--dato YYYY-MM-DD] [--merknad "…"]
//        (sist_revidert, ny versjon og en linje i revisjoner; gir ny neste revisjon)
//   node scripts/orkestrator/ko.mjs plan dok sjekk [--skriv] [--torr] [--json]   (konsistenssjekkene i koPlan.js, f.eks.
//        leverandørlista mot konfig().dokumenter og forfalte revisjoner; --skriv fører funnene inn som problemer med
//        kilde sjekk:<type>; vises også i `plan sjekk`)
//   node scripts/orkestrator/ko.mjs plan dok nett [--skriv] [--torr] [--json]    (bare manuelt: GET på de publiserte
//        nettadressene, svarer de og står versjonen der)
//
// Budsjettvakt: med grenser.dagsbudsjett satt (USD API-ekvivalent per døgn i Europe/Oslo, eieren setter tallet) foreslår
// `neste` ingenting og `start` nekter når dagens forbruk har nådd grensen. Forbruket leses fra tidsloggen
// (konfig().tidslogg), deduplisert per agent (lib/tidKost.js, samme tall som `logg-tid.mjs --kost`). Standard: av.
//
// Nattpause: med grenser.nattkjoring = false (`ko.mjs grense nattkjoring av`) foreslår `neste` ingenting (exit 5,
// «Nattpause til 06:00 …») og `start` nekter (exit 5) inne i nattvinduet (grenser.nattvindu, standard 23-06, norsk
// tid). Kjørende oppgaver går ferdig, og `sett`/`lever`/fletting fortsetter; bare nye starter stopper. Som for
// budsjettvakta (exit 4) er det ikke en tom kø. `start --tving` overstyrer. Standard: på (ingen nattpause).
//
// Avviklingsvakt: når den aktive orkestratorøkta passerer ca. 350k kontekst, setter hook-kontekst.mjs `avvikling` i
// orkestrator-markøren. Da nekter `neste`, `start` og `fyll` (exit 6): økta gjør ferdig mottak, review, retterunder og
// fletting (`sett`, `avklar`, `motta` virker som før), oppdaterer den løpende overleveringslappen og komprimeres.
// hook-etter-kompakt.mjs opphever avviklingen etter komprimeringen. Nødrotasjon (økta har hengt):
// `orkestrator puls --okt "<nytt navn>"` (ny økt tar markøren) eller `orkestrator stopp` nullstiller også.
// `start --tving` (eierens ord) overstyrer.
//
// Exit-koder: 0 ok, 1 feil, 3 tom kø (tilstand), 4 dagsbudsjettet er brukt opp (neste, start), 5 nattpause (neste,
// start), 6 orkestratoren er i avvikling (neste, start, fyll) eller køen er endret siden forhåndsvisningen
// (--forvent-endret).
//
// Oppgavefelt (se koLogikk.valider): id, tittel, domene, klasse (K|D|D+|U), oppdrag (sti til en sporbeskrivelse
// eller selve teksten), nytte (1–10, standard 5), innhold_min (min for et K-spor, standard 30), migr_tiere (antall
// blokker med migrasjonsnumre, 0 for klient/utredning; brukes bare med migrasjonsflyten), avhenger [id], venter_paa
// [eierspørsmål], eier_filer [sti eller mappe/], eier_db [funksjon], delt_patch [delt funksjon], kilde (plan og
// delplan), lagt_til_av, prosjekt (pid), plan (planpost-id i planer.json), funksjon (kort navn), etiketter (f.eks.
// ["visuell"]), krever (ressurser, se koLogikk.KREVER), samles (true = samlekøen). Satt av verktøyet: plukket_av,
// plukket_at, qa_status (venter|ok|avvik), qa_notat, qa_original (på en rettingsoppgave).
// =============================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawn, spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const L = require('./lib/koLogikk.js');
const KV = require('./lib/kontekstVakt.js');
const TK = require('./lib/tidKost.js');
const G = require('./lib/koGit.js');
const D = require('./lib/koDiagnose.js');
const P = require('./lib/koPlan.js');
const S = require('./lib/koStatistikk.js');
const KAP = require('./lib/koKapasitet.js');
const KK = require('./lib/koKonfig.js');

// Prosjektets innstillinger (ko.config.json flettet med standardverdiene i lib/koKonfig.js).
const KONFIG = KK.konfig();
// Integrasjonsgrenen alt flettes til (ofte main), remoten og grenprefikset for køoppgaver.
const BASE = KONFIG.baseGren;
const REMOTE = KONFIG.remote;
const PREFIKS = KONFIG.grenPrefiks ?? 'ko/';
/** Grenen til en køoppgave: <grenPrefiks><id>. */
const grenFor = (id) => `${PREFIKS}${id}`;
// Den valgfrie migrasjonsflyten (mappe null = av: ingen nummerblokker og ingen push i flett).
const MIGR = KONFIG.migrasjoner ?? { mappe: null };

// Skriptet ligger i <rot>/scripts/orkestrator/; rota er to mapper opp.
const ROT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Køen bor ALLTID i hovedtreet. Kjøres verktøyet fra et worktree (.claude/worktrees/<navn>), går vi opp til
// hovedtreet, ellers ville hvert spor fått sin egen, tomme kø. KO_MAPPE overstyrer (tester).
const HOVEDTRE = ROT.split(`${path.sep}.claude${path.sep}worktrees${path.sep}`)[0];
const MAPPE = KK.dataMappe();
const FIL = path.join(MAPPE, 'ko.json');
const LAS = path.join(MAPPE, '.las');
// Tidsloggen med forbruket per agent (hook-tid.mjs skriver den). KO_TIDSLOGG overstyrer (tester).
const TIDSLOGG = KK.tidslogg();
// Repoet køgrenene telles i (plukk, slipp, vis). KO_GIT overstyrer (røyktest mot et midlertidig repo).
const GIT_ROT = process.env.KO_GIT ?? HOVEDTRE;
const a = process.argv.slice(2);
const kmd = a[0];

const verdi = (navn) => {
  const i = a.indexOf(navn);
  return i >= 0 ? a[i + 1] : undefined;
};
// Alle verdiene etter et flagg, fram til neste flagg (`--prefiks A- B-`); flagget kan også gjentas.
const verdier = (navn) => {
  const ut = [];
  a.forEach((x, i) => {
    if (x !== navn) return;
    for (let j = i + 1; j < a.length && !a[j].startsWith('--'); j++) ut.push(a[j]);
  });
  return ut;
};
// Posisjonsargumentene etter kommandoen, uten flagg og flaggverdier (flaggene med verdi står i `medVerdi`).
const posisjonelle = (fra, medVerdi = []) =>
  a.slice(fra).filter((x, i, arr) => !x.startsWith('--') && !medVerdi.includes(arr[i - 1]));

// Bredden i terminalen (smalt vindu: kortere titler). Utenfor en terminal (rør, logg) brukes 110.
const BREDDE = Math.max(60, Math.min(process.stdout.columns || 110, 160));
const kutt = (s, n) => {
  const t = String(s ?? '');
  return n <= 1 ? '' : t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// ---- Git (køgrenene) ---------------------------------------------------------------------------------------
function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: GIT_ROT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** Finnes grenen, hvor mange commits har den foran basegrenen, og når var den siste? */
function grenInfo(gren) {
  if (git(['rev-parse', '-q', '--verify', `refs/heads/${gren}`]) == null)
    return { finnes: false, commits: 0, sisteCommit: null };
  const commits = Number(git(['rev-list', '--count', `${BASE}..${gren}`]) ?? 0) || 0;
  const sisteCommit = commits > 0 ? git(['log', '-1', '--format=%cI', gren]) : null;
  return { finnes: true, commits, sisteCommit };
}

/** Oppdragsfila (absolutt sti) når `oppdrag` er en sti som finnes i worktreet eller hovedtreet, ellers null. */
function oppdragFil(o) {
  const s = String(o.oppdrag ?? '');
  if (!s || s.includes('\n')) return null;
  for (const rot of [ROT, HOVEDTRE]) {
    const sti = path.resolve(rot, s);
    try {
      if (fs.statSync(sti).isFile()) return sti;
    } catch {
      /* finnes ikke her */
    }
  }
  return null;
}

/** «plukket av X for 3 t siden · 2 commits · GAMMEL» for en plukket oppgave. */
function plukkLinje(o) {
  const g = grenInfo(o.gren ?? grenFor(o.id));
  const alder = o.plukket_at ? L.alderTekst(Date.now() - Date.parse(o.plukket_at)) : '?';
  const gammel = L.erGammelPlukk(o, g)
    ? ' · GAMMEL (over 72 t uten commits; slippes aldri automatisk)'
    : '';
  return `plukket av ${o.plukket_av ?? '?'} for ${alder} siden · ${g.commits} commit(s) på ${o.gren ?? grenFor(o.id)}${gammel}`;
}
// ---- Samlekøen ----------------------------------------------------------------------------------------
/** «K  65 / 90–120 min  [######------]  mangler 25 min  (3 oppgaver)» for en gruppe fra koLogikk.samleGrupper. */
function samleGruppeLinje(g) {
  const bredde = 12;
  const fylt = g.maal ? Math.round(Math.min(g.sum / g.maal.maks, 1) * bredde) : 0;
  const stolpe = `[${'#'.repeat(fylt)}${'-'.repeat(bredde - fylt)}]`;
  const status = g.ugyldig
    ? `UGYLDIG (${g.klasse} pakkes ikke; ta den ut med endre --json '{"samles":false}')`
    : g.klar
      ? g.over
        ? 'KLAR TIL PAKKING (over øvre mål: blir flere pakker)'
        : 'KLAR TIL PAKKING'
      : `mangler ${g.maal.min - g.sum} min`;
  const maal = g.maal ? `${g.maal.min}–${g.maal.maks}` : '?';
  return `${String(g.klasse).padEnd(2)} ${`${g.sum} / ${maal} min`.padEnd(17)} ${stolpe}  ${status}  (${g.antall} oppgave(r))`;
}

/** Oppdragsteksten til en oppgave som skal pakkes: fila (worktree eller hovedtre), ellers teksten i køfila. */
function lesOppdrag(o) {
  const s = String(o.oppdrag ?? '');
  const fil = oppdragFil(o);
  if (fil) return { tekst: fs.readFileSync(fil, 'utf8'), sti: s };
  if (!s.includes('\n') && /\.md$/i.test(s.trim()))
    return { feil: `${o.id}: fant ikke oppdragsfila ${s}` };
  return { tekst: s, sti: null };
}

/** `oppdrag`-feltet for en ny oppdragsfil: relativt til hovedtreet (<dataMappe>/oppdrag/<id>.md), ellers absolutt. */
function oppdragRef(fil) {
  const rel = path.relative(HOVEDTRE, fil);
  return (rel.startsWith('..') || path.isAbsolute(rel) ? fil : rel).replace(/\\/g, '/');
}

/**
 * Utfører pakkeplanen under låsen, ALT ELLER INGENTING: `planFn(ko)` gir [{ id, deler, tittel, ut }] (regnet inne i
 * låsen). `ut` tar en enkelt oppgave ut av samlekøen; ellers koLogikk.samlePakk. Feiler én pakke, skrives ingenting.
 * Oppdragsfilene skrives først (aldri over en eksisterende), så køfila; feiler skrivingen, fjernes filene igjen.
 */
function samlePakkUtfor(planFn) {
  return medLas(() => {
    const ko = les();
    // Tavla sender --forvent-endret (køens versjon fra forhåndsvisningen); exit 6 når køen er endret siden.
    sjekkForvent(ko);
    const plan = planFn(ko);
    if (!plan.length) dø('Ingen grupper i samlekøen er klare til pakking. Ingenting er endret.');
    const naa = new Date().toISOString();
    const resultat = [];
    const filer = [];
    for (const p of plan) {
      if (p.ut) {
        const o = ko.oppgaver.find((x) => x.id === p.deler[0]);
        if (!o) dø(`Ukjent oppgave ${p.deler[0]}. Ingenting er endret.`);
        delete o.samles;
        resultat.push({ ut: true, id: o.id, sum: p.sum });
        continue;
      }
      const fil = path.join(MAPPE, 'oppdrag', `${p.id}.md`);
      if (fs.existsSync(fil)) dø(`Oppdragsfila finnes fra før: ${fil}. Ingenting er endret.`);
      if (filer.some((f) => f.fil === fil)) dø(`${p.id} står to ganger. Ingenting er endret.`);
      const tekster = new Map();
      const feil = [];
      for (const id of p.deler) {
        const o = ko.oppgaver.find((x) => x.id === id);
        if (!o) continue; // samlePakk melder ukjente id-er
        const t = lesOppdrag(o);
        if (t.feil) feil.push(t.feil);
        else tekster.set(id, t);
      }
      if (feil.length) dø(`Ingenting pakket:\n  ${feil.join('\n  ')}`);
      const r = L.samlePakk(ko, p.deler, {
        nyId: p.id,
        tittel: p.tittel,
        oppdrag: oppdragRef(fil),
        av: 'ko.mjs samle pakk',
        naa,
      });
      if (r.feil.length) dø(`Ingenting pakket (${p.id ?? 'uten id'}):\n  ${r.feil.join('\n  ')}`);
      const deler = p.deler.map((id) => ko.oppgaver.find((x) => x.id === id));
      filer.push({ fil, tekst: L.samleOppdragTekst(r.ny, deler, tekster, naa) });
      resultat.push({ ...r, sum: r.ny.innhold_min });
    }
    const skrevet = [];
    try {
      fs.mkdirSync(path.join(MAPPE, 'oppdrag'), { recursive: true });
      for (const f of filer) {
        fs.writeFileSync(f.fil, f.tekst, { flag: 'wx' });
        skrevet.push(f.fil);
      }
      skriv(ko);
    } catch (e) {
      for (const f of skrevet) fs.rmSync(f, { force: true });
      dø(`Ingenting pakket: ${e?.message ?? e}`);
    }
    return resultat;
  });
}

/** Én linje per utført pakke (eller oppgave tatt ut av samlekøen). */
function samleUtfortLinje(p) {
  if (p.ut) return `${p.id}: tatt ut av samlekøen (${p.sum} min alene).`;
  return (
    `Pakket ${p.ny.id} (${p.ny.klasse}, ${p.sum} min, status ${p.ny.status}) av ${p.kansellert.join(', ')} ` +
    `(kansellert); oppdrag ${p.ny.oppdrag}` +
    (p.omdirigert.length ? `; avhenger pekt om i ${p.omdirigert.join(', ')}` : '') +
    '.'
  );
}

// ---- Arbeid utenfor køen og orkestrator-markøren --------------------------------------------------------
// Bare lesing, med --no-optional-locks (koGit.js): en skanning tar aldri index.lock fra en økt som committer.
const gitLes = G.lagGit(GIT_ROT);

/** Stiene `git status` viser i hovedtreet. Kan de ikke leses, meldes det, og ingenting hoppes over. */
function ucommittetStier() {
  const u = G.lesUcommittet(gitLes);
  if (u == null) {
    console.error(
      'ADVARSEL: kunne ikke lese git status i hovedtreet; ucommittede filer er ikke sjekket.',
    );
    return [];
  }
  return u.map((x) => x.sti);
}

// Markøren for «orkestrator aktiv» ligger ved siden av køfila (gitignorert), som en egen fil.
const MARKOR = path.join(MAPPE, 'orkestrator.json');
function lesMarkor() {
  try {
    return JSON.parse(fs.readFileSync(MARKOR, 'utf8'));
  } catch {
    return null;
  }
}
/** Oppdaterer markøren (økt-navn: --okt, ellers KO_OKT, ellers forrige). Feil stopper aldri køen. */
function pulsMarkor(hendelse) {
  try {
    fs.mkdirSync(MAPPE, { recursive: true });
    const m = L.nyMarkor(lesMarkor(), { okt: verdi('--okt') ?? process.env.KO_OKT, hendelse });
    const tmp = `${MARKOR}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n');
    fs.renameSync(tmp, MARKOR);
    return m;
  } catch {
    return null;
  }
}

/** Skriver advarselen for `start`/`plukk` når eierfilene er endret utenfor køen siden oppgaven ble lagt inn. */
function skrivEksternVarsel(o) {
  const v = G.eksternForOppgaver(gitLes, [o]).get(o.id);
  if (!v) return;
  if (v.kollisjoner.length) {
    console.log(
      `ADVARSEL: ${v.kollisjoner.length} endring(er) i eierfilene utenfor køen siden ${o.id} ble lagt inn. ` +
        'Sporfila får advarselen (ko.mjs sporfil), så sporet leser diffen før det bygger:',
    );
    for (const k of v.kollisjoner.slice(0, 5))
      console.log(`  ${L.kollisjonTekst(k, { medId: false })}`);
    if (v.kollisjoner.length > 5)
      console.log(`  … og ${v.kollisjoner.length - 5} til (ko.mjs ekstern --alle)`);
  }
  if (v.nevnt.length)
    console.log(
      `OBS: commits utenfor køen nevner ${o.id}; er den alt gjort? (ko.mjs ekstern godta ${o.id} <sha>): ` +
        v.nevnt
          .slice(0, 3)
          .map((c) => `${c.kort} «${c.emne.slice(0, 50)}»`)
          .join(', '),
    );
}

// process.exit hopper over finally-blokker: slipp låsen her, ellers blir den liggende i 60 s og stopper alle
// andre kall (f.eks. «kan ikke startes» inne i låsen ville ellers blokkert køen).
let harLas = false;
const dø = (melding, kode = 1) => {
  console.error(melding);
  if (harLas) fs.rmSync(LAS, { recursive: true, force: true });
  process.exit(kode);
};

// ---- Lås og lagring ----------------------------------------------------------------------------------------
function medLas(fn) {
  fs.mkdirSync(MAPPE, { recursive: true });
  const frist = Date.now() + 15_000;
  for (;;) {
    try {
      fs.mkdirSync(LAS);
      harLas = true;
      break;
    } catch {
      // En lås eldre enn 60 s er etterlatt av en prosess som døde: fjern den.
      try {
        if (Date.now() - fs.statSync(LAS).mtimeMs > 60_000)
          fs.rmSync(LAS, { recursive: true, force: true });
      } catch {
        /* låsen forsvant mellom sjekkene */
      }
      if (Date.now() > frist) dø(`Fikk ikke låsen på ${MAPPE} (prøvde i 15 s). Prøv igjen.`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(LAS, { recursive: true, force: true });
    harLas = false;
  }
}

function les() {
  if (!fs.existsSync(FIL)) dø('Køen finnes ikke. Kjør: node scripts/orkestrator/ko.mjs init');
  return JSON.parse(fs.readFileSync(FIL, 'utf8'));
}

// Det korte diagnoseavsnittet når parallelliteten er lav (fyll, motta, orkestrator puls). Leser køen på
// nytt, så spor som nettopp er startet eller mottatt, telles. Skriver ingenting når parallelliteten ikke er lav, og en
// feil i diagnosen stopper aldri kommandoen den henger på.
function parallellVarsel() {
  try {
    for (const l of D.diagnoseLinjer(D.parallellDiagnose(les()))) console.log(l);
  } catch (e) {
    console.log(`(Kødiagnosen feilet: ${e?.message ?? e}. Kjør ko.mjs diagnose.)`);
  }
}

function skriv(ko) {
  ko.endret = new Date().toISOString();
  const tmp = `${FIL}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ko, null, 2) + '\n');
  fs.renameSync(tmp, FIL);
}

const endre = (fn) =>
  medLas(() => {
    const ko = les();
    const svar = fn(ko);
    skriv(ko);
    return svar;
  });

// Hvem som gjorde endringen (endringsloggen) og optimistisk samtidighet (--forvent-endret).
const avNavn = () => verdi('--av') ?? 'ko.mjs';
/** Nekter med exit 6 når køen er endret etter tidspunktet kalleren forhåndsviste (kalles under låsen). */
function sjekkForvent(ko) {
  const f = L.forventSjekk(ko, verdi('--forvent-endret') ?? null);
  if (!f) return;
  const kode = f.startsWith('ugyldig') ? 1 : 6;
  if (a.includes('--json')) {
    console.log(JSON.stringify({ ok: false, feil: [f], utdatert: kode === 6 }));
    if (harLas) fs.rmSync(LAS, { recursive: true, force: true });
    process.exit(kode);
  }
  dø(`Ingenting endret: ${f}`, kode);
}
/** Posten endreLogget la i endringsloggen (null når ingenting endret seg). */
let sistePost = null;
/**
 * Som endre, men sjekker --forvent-endret og legger det som faktisk endret seg (oppgaver og prosjektregisteret) i
 * endringsloggen, så `ko.mjs angre` kan rulle det tilbake.
 */
const endreLogget = (handling, fn) =>
  medLas(() => {
    const ko = les();
    sjekkForvent(ko);
    const forKo = L.klonJson({ oppgaver: ko.oppgaver ?? [], prosjekter: ko.prosjekter ?? {} });
    const svar = fn(ko);
    sistePost = L.loggEndring(ko, {
      av: avNavn(),
      handling,
      endringer: L.masseDiff(forKo, ko),
      naa: new Date().toISOString(),
    });
    skriv(ko);
    return svar;
  });
/** «(angre: ko.mjs angre)» etter en logget skriving. */
const angreHint = () =>
  sistePost
    ? `Endringslogg nr. ${sistePost.nr} (${sistePost.endringer.length} felt); angre: ko.mjs angre`
    : null;

// ---- Planregisteret: lagring under samme lås som køen --------------------------------------------------
const PLANFIL = path.join(MAPPE, 'planer.json');
// Kildestiene i planpostene er relative til hovedtreet. Testene setter en egen rot (KO_PLAN_KILDEROT).
const KILDEROT = process.env.KO_PLAN_KILDEROT ?? HOVEDTRE;

function lesPlaner() {
  if (!fs.existsSync(PLANFIL)) return P.tomtRegister();
  return P.normaliser(JSON.parse(fs.readFileSync(PLANFIL, 'utf8')));
}
// `bump: false` (plan aktiv) lar `endret` stå: en puls er ingen planendring og skal ikke gjøre --forvent-endret utdatert.
function skrivPlaner(reg, { bump = true } = {}) {
  if (bump) reg.endret = new Date().toISOString();
  const tmp = `${PLANFIL}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n');
  fs.renameSync(tmp, PLANFIL);
}
/** Køen bare til lesing (prosjekter, områder, oppgaver, eierspørsmål); tom når den ikke finnes. */
const lesKoForPlan = () => (fs.existsSync(FIL) ? les() : {});
/** Finnes kildestien under kilderota? Aldri utenfor rota (koPlan.kildestiFeil har alt avvist .. og absolutte stier). */
function finnesKilde(sti) {
  const full = path.resolve(KILDEROT, sti);
  const rel = path.relative(KILDEROT, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return fs.existsSync(full);
}
/** Rollen til den som kaller: agent (standard) eller eier. */
function planRolle() {
  const r = verdi('--satt-av') ?? 'agent';
  if (!P.SATT_AV.includes(r)) dø(`--satt-av må være ${P.SATT_AV.join(' eller ')}`);
  return r;
}
/** Feil fra en plan-kommando: som JSON med --json (tavla), ellers som tekst. Slipper låsen. */
function planFeil(feil, kode = 1, ekstra = {}) {
  if (a.includes('--json')) {
    console.log(JSON.stringify({ ok: false, feil, ...ekstra }));
    if (harLas) fs.rmSync(LAS, { recursive: true, force: true });
    process.exit(kode);
  }
  dø(`Ingenting endret:\n  ${feil.join('\n  ')}`, kode);
}
/**
 * Skriving i planregisteret: under låsen, --forvent-endret mot planer.json, alt eller ingenting. `fn(reg, ko)` endrer
 * `reg` og gir svaret ({ feil, advarsler, … }); feil gir exit uten skriving. Med --torr skrives ingenting, og svaret har
 * endringene. Ellers føres endringene i registerets endringslogg (angres med `plan angre`).
 */
function endrePlaner(handling, fn) {
  const torr = a.includes('--torr');
  return medLas(() => {
    const reg = lesPlaner();
    const fe = P.forventSjekk(reg, verdi('--forvent-endret') ?? null);
    if (fe)
      planFeil([fe], fe.startsWith('ugyldig') ? 1 : 6, { utdatert: !fe.startsWith('ugyldig') });
    const versjon = reg.endret ?? null;
    const forReg = JSON.parse(
      JSON.stringify({ poster: reg.poster, arkiv: reg.arkiv, dokumenter: reg.dokumenter }),
    );
    const svar = fn(reg, lesKoForPlan());
    if (svar.feil?.length) planFeil(svar.feil, 1, { advarsler: svar.advarsler ?? [] });
    const endringer = P.planDiff(forReg, reg);
    if (torr) return { ...svar, endringer, versjon, torr: true, logg: null };
    const post = P.loggEndring(reg, { av: avNavn(), handling, endringer });
    if (post) skrivPlaner(reg);
    return { ...svar, endringer, versjon: reg.endret ?? versjon, logg: post?.nr ?? null };
  });
}
/** Linjene i forhåndsvisningen og etter en skriving. */
const planDiffLinjer = (endringer) =>
  L.diffLinjer(
    endringer.map((e) => ({
      ...e,
      id: e.samling === 'arkiv' ? `${e.id} (arkiv)` : e.id,
      felt: e.felt === '*' ? (e.for == null ? 'ny' : 'fjernet') : e.felt,
      for: e.felt === '*' && e.for ? e.for.tittel : e.for,
      etter: e.felt === '*' && e.etter ? e.etter.tittel : e.etter,
    })),
  );
/** Svaret etter en skrivende plan-kommando (tekst eller JSON). */
function planSvar(r, overskrift) {
  if (a.includes('--json')) {
    console.log(
      JSON.stringify({
        ok: true,
        torr: Boolean(r.torr),
        endringer: r.endringer,
        advarsler: r.advarsler ?? [],
        logg: r.logg,
        endret: r.versjon,
        ...(r.post ? { post: r.post } : {}),
        ...(r.dok ? { dok: r.dok } : {}),
        ...(r.loft?.length ? { loft: r.loft } : {}),
      }),
    );
    return;
  }
  console.log(`${r.torr ? 'Forhåndsvisning (ingenting skrevet): ' : ''}${overskrift}`);
  for (const l of planDiffLinjer(r.endringer)) console.log(`  ${l}`);
  if (!r.endringer.length) console.log('  (ingen endring)');
  for (const x of r.advarsler ?? []) console.log(`ADVARSEL: ${x}`);
  if (r.logg) console.log(`Endringslogg nr. ${r.logg} i planer.json; angre: ko.mjs plan angre`);
}
/** Posisjonsargumentene før det første flagget (`plan prioriter A B naa --kategori …`). */
const forFlagg = (fra) => {
  const ut = [];
  for (const x of a.slice(fra)) {
    if (x.startsWith('--')) break;
    ut.push(x);
  }
  return ut;
};
/** Én linje i `plan vis`. */
function planRad(p) {
  const pri =
    p.prioritet === 'naa' && p.naa_kategori?.length
      ? `naa/${p.naa_kategori.join('+')}`
      : p.prioritet;
  const mod = `${p.avledet.modenhet}${p.avledet.brok ? ` ${p.avledet.brok}` : ''}${p.avledet.foreldet ? ' (foreldet)' : ''}`;
  const fast = `${p.id.padEnd(16)} ${pri.padEnd(18)} ${mod.padEnd(14)} ${(p.estimat ?? '-').padEnd(3)} ${(p.prosjekt ?? '').padEnd(16)} `;
  return kutt(`${fast}${p.tittel}${p.frist ? ` (frist ${p.frist})` : ''}`, BREDDE);
}

// ---- plan sjekk, plan moduler og plan backup ----------------------------------------

/** .md-filene under koPlan.DOKUMENT_MAPPER (relative stier med skråstrek), uten skjulte mapper og node_modules. */
function planDokumenter() {
  const ut = [];
  const gaa = (rel) => {
    let liste;
    try {
      liste = fs.readdirSync(path.join(KILDEROT, rel), { withFileTypes: true });
    } catch {
      return; // mappa finnes ikke
    }
    for (const d of liste) {
      if (d.name.startsWith('.') || d.name === 'node_modules') continue;
      const r = `${rel}/${d.name}`;
      if (d.isDirectory()) gaa(r);
      else if (d.isFile() && d.name.toLowerCase().endsWith('.md')) ut.push(r);
    }
  };
  for (const m of P.DOKUMENT_MAPPER) gaa(m);
  return ut;
}
/** Større dokumenter leses ikke for statusavviket (de er ikke planer). */
const DOK_MAKS_BYTE = 2 * 1024 * 1024;
/** Teksten i en kilde (bare under kilderota), eller null. */
function lesDok(sti) {
  if (P.kildestiFeil(sti) || !finnesKilde(sti)) return null;
  try {
    const full = path.resolve(KILDEROT, sti);
    const st = fs.statSync(full);
    if (!st.isFile() || st.size > DOK_MAKS_BYTE) return null;
    return fs.readFileSync(full, 'utf8');
  } catch {
    return null;
  }
}
const kildeGit = G.lagGit(KILDEROT);
/**
 * Filene (av `filer`) som er endret i HEAD etter verifiseringen: etter commiten når den er kjent, ellers etter dagen.
 * En ukjent commit eller en mappe som ikke er et git-repo gir en tom liste (ingenting å si).
 */
function endredeFiler(filer, { dato, commit }) {
  const trygg = typeof commit === 'string' && /^[0-9a-f]{4,40}$/i.test(commit);
  const args = trygg
    ? ['log', '--format=', '--name-only', `${commit}..HEAD`, '--', ...filer]
    : ['log', '--format=', '--name-only', `--since=${dato}T23:59:59`, 'HEAD', '--', ...filer];
  const ut = kildeGit(args);
  if (ut == null) return [];
  return [
    ...new Set(
      ut
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ].sort();
}

/** `plan sjekk [--json] [--maks N]`: hygienen i planregisteret. Leser bare; endrer ingenting. */
function planSjekk(json) {
  const ko = lesKoForPlan();
  const reg = lesPlaner();
  const dager = S.dagerBakover(Date.now(), P.KAPASITET_VINDU_DAGER);
  const ferdigePerUke = S.ferdigeIVindu(ko, dager).length / (P.KAPASITET_VINDU_DAGER / 7);
  const r = P.sjekk(reg, ko, {
    dokumenter: planDokumenter(),
    finnesSti: finnesKilde,
    lesDok,
    endredeFiler,
    ferdigePerUke,
    prosjektFor: (o) => L.prosjektFor(o, ko.prosjekter ?? {}),
  });
  if (json) {
    console.log(JSON.stringify({ ok: true, endret: reg.endret ?? null, ...r }));
    return;
  }
  const maks = Number(verdi('--maks') ?? 15) || 15;
  const del = (tittel, liste, linje) => {
    if (!liste.length) return;
    console.log(`\n${tittel} (${liste.length})`);
    for (const x of liste.slice(0, maks)) console.log(`  ${kutt(linje(x), BREDDE - 2)}`);
    if (liste.length > maks) console.log(`  … ${liste.length - maks} til (--maks N eller --json)`);
  };
  const hvem = (x) => x.id ?? x.oppgave ?? x.prosjekt ?? '';
  console.log(`Plan sjekk: ${reg.poster.length} poster, ${r.antall} funn. ${r.kapasitet.tekst}`);
  del('Uregistrert (ingen post peker til dokumentet)', r.uregistrert, (s) => s);
  del('Døde stier', r.dode_stier, (x) => `${x.id}: ${x.sti}`);
  del('Foreldet', r.foreldet, (x) => `${x.id}: ${x.grunn}`);
  del('Bygget, men ikke verifisert (plan verifiser)', r.ikke_verifisert, (s) => s);
  del('Statusavvik', r.statusavvik, (x) => `${hvem(x)}: ${x.grunn}`);
  del('Regelavvik (prioritetsreglene, endres ikke av seg selv)', r.regelavvik, (x) => `${x.id}: ${x.grunn}`);
  del('Hull', r.hull, (x) => `${x.id}: ${x.grunn}`);
  del(
    'Mulige duplikater (plan slaa-sammen)',
    r.duplikater,
    (x) => `${x.ider.join(' + ')}: ${x.grunn}`,
  );
  if (r.kapasitet.uten_estimat.length)
    console.log(`\nNå uten estimat: ${r.kapasitet.uten_estimat.join(', ')}`);
  // Referansedokumenter og historikk er registrert, men leses ikke for status (ikke funn).
  if (r.referanser?.length)
    console.log(
      `\nReferanse og historikk (registrert, ingen statussjekk): ${r.referanser.length} kilde(r) i ` +
        `${new Set(r.referanser.map((x) => x.id)).size} post(er)`,
    );
  // Konsistenssjekkene for Dokumenter og avtaler.
  if (r.dok_konsistens)
    del(
      'Dokumenter og avtaler (plan dok sjekk --skriv fører dem inn som problemer)',
      r.dok_konsistens,
      dokFunnLinje,
    );
}

// ---- Konsistenssjekkene for Dokumenter og avtaler ---------------------------------------------

/** Én linje per konsistensfunn. */
const dokFunnLinje = (f) =>
  `${f.alvor.padEnd(7)} ${(f.dok ?? '-').padEnd(16)} ${f.sjekk}: ${f.tekst}`;

/** Leser en side (bare GET, uten innlogging, høyst 2 MB, 10 s). Gir { status, tekst } eller { feil }. */
async function hentSide(url) {
  try {
    const svar = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
      headers: { 'user-agent': 'ko-plan-dok-nett' },
    });
    const tekst = (await svar.text()).slice(0, 2 * 1024 * 1024);
    return { status: svar.status, tekst };
  } catch (e) {
    return { feil: e?.name === 'TimeoutError' ? 'tidsavbrudd' : (e?.code ?? e?.message ?? 'feil') };
  }
}

/** Svaret fra `plan dok sjekk` og `plan dok nett` (tekst eller JSON), med det som ble skrevet. */
function dokSjekkSvar(json, funn, kjorte, skrevet) {
  if (json) {
    console.log(
      JSON.stringify({
        ok: true,
        kjorte,
        funn,
        ...(skrevet
          ? {
              torr: Boolean(skrevet.torr),
              endret_dok: skrevet.endret,
              endringer: skrevet.endringer,
              logg: skrevet.logg,
              endret: skrevet.versjon,
            }
          : {}),
      }),
    );
    return;
  }
  console.log(`Konsistenssjekk (${kjorte.join(', ')}): ${funn.length} funn.`);
  for (const f of funn) console.log(`  ${kutt(dokFunnLinje(f), BREDDE - 2)}`);
  if (skrevet) {
    console.log(
      `${skrevet.torr ? 'Forhåndsvisning (ingenting skrevet): ' : ''}Problemer oppdatert i ${skrevet.endret.length} dokument(er)${skrevet.endret.length ? `: ${skrevet.endret.join(', ')}` : ''}`,
    );
    for (const l of planDiffLinjer(skrevet.endringer)) console.log(`  ${l}`);
    for (const x of skrevet.advarsler ?? []) console.log(`ADVARSEL: ${x}`);
    if (skrevet.logg)
      console.log(`Endringslogg nr. ${skrevet.logg} i planer.json; angre: ko.mjs plan angre`);
  } else if (funn.some((f) => f.dok && f.sjekk !== 'revisjon'))
    console.log('Før dem inn som problemer: legg til --skriv (--torr viser først).');
}

/** Fører funnene inn som problemer (under låsen, logget og angrbar) når --skriv er med. */
function dokSkrivFunn(funn, kjorte) {
  if (!a.includes('--skriv')) return null;
  const rolle = planRolle();
  return endrePlaner('plan dok sjekk', (reg, ko) =>
    P.synkKonsistens(reg, funn, kjorte, {
      rolle,
      av: avNavn(),
      sporsmal: ko.sporsmal ?? {},
      finnesSti: finnesKilde,
    }),
  );
}

/** `plan dok sjekk [--skriv] [--torr] [--json]`: leverandørlister og forfalte revisjoner. */
function planDokSjekk(json) {
  const r = P.dokKonsistens(lesPlaner(), lesKoForPlan(), { lesDok });
  if (!r.kjorte.length) {
    if (json) console.log(JSON.stringify({ ok: true, kjorte: [], funn: [] }));
    else console.log('Dokumentregisteret er tomt; ingenting å sjekke.');
    return;
  }
  dokSjekkSvar(json, r.funn, r.kjorte, dokSkrivFunn(r.funn, r.kjorte));
}

/**
 * `plan dok nett [--skriv] [--torr] [--json]`: henter de publiserte nettadressene (bare lesing, bare manuelt) og ser at
 * de svarer og viser versjonen registeret sier. Låsen holdes ikke mens sidene hentes; skrivingen tar den etterpå.
 */
async function planDokNett(json) {
  const adr = P.nettAdresser(lesPlaner());
  const funn = [];
  for (const { dok, pub } of adr) funn.push(...P.vurderNettsvar(dok, pub, await hentSide(pub.url)));
  if (!json) console.log(`Hentet ${adr.length} nettadresse(r).`);
  dokSjekkSvar(json, funn, ['nett'], dokSkrivFunn(funn, ['nett']));
}

/**
 * `plan moduler [--koble] [--torr] [--json]`: oppretter modulene (konfig().moduler) som mangler i `omrader`;
 * de som finnes, endres ikke. Med --koble får prosjekter uten modul forslaget i konfig().prosjektModulForslag (logget, angres
 * med ko.mjs angre). --torr viser hva som ville skjedd.
 */
function planModuler(json) {
  const koble = a.includes('--koble');
  const gjor = (ko) => {
    const plan = P.modulPlan(ko, { koble });
    const feil = [];
    for (const m of plan.nye) {
      const s = L.settOmrade(ko, m.oid, { tittel: m.tittel, beskrivelse: m.beskrivelse });
      feil.push(...s.feil);
    }
    for (const k of plan.koble) {
      const reg = L.nyttRegister(ko.prosjekter, { [k.pid]: { omrade: k.oid } }, ko.omrader);
      if (reg.feil.length) feil.push(...reg.feil);
      else ko.prosjekter = reg.register;
    }
    return { ...plan, feil };
  };
  const forhand = gjor(L.klonJson(les()));
  if (forhand.feil.length) dø(`Ingenting endret:\n  ${forhand.feil.join('\n  ')}`);
  const tomt = !forhand.nye.length && !forhand.koble.length;
  const torr = a.includes('--torr');
  const r =
    torr || tomt
      ? forhand
      : endreLogget('plan moduler', (ko) => {
          const s = gjor(ko);
          if (s.feil.length) dø(`Ingenting endret:\n  ${s.feil.join('\n  ')}`);
          return s;
        });
  if (json) {
    console.log(JSON.stringify({ ok: true, torr, nye: r.nye, finnes: r.finnes, koble: r.koble }));
    return;
  }
  const pre = torr ? 'Forhåndsvisning (ingenting skrevet): ' : '';
  console.log(
    `${pre}${r.nye.length ? `nye moduler: ${r.nye.map((m) => `${m.oid} (${m.tittel})`).join(', ')}` : 'alle modulene finnes'}`,
  );
  if (r.finnes.length)
    console.log(`Finnes fra før (uendret): ${r.finnes.map((m) => m.oid).join(', ')}`);
  if (r.koble.length)
    console.log(
      `${pre}prosjekter koblet til modul: ${r.koble.map((k) => `${k.pid} → ${k.oid}`).join(', ')}`,
    );
  if (!torr && !tomt && angreHint()) console.log(angreHint());
  if (!koble)
    console.log(
      'Prosjektene kobles med ko.mjs plan moduler --koble (forslag) eller ko.mjs prosjekt <pid> --omrade <oid>.',
    );
}

/**
 * Backup-skriptet for planregisteret: konfig().planBackup (sti relativt til prosjektrota eller absolutt), null = ikke
 * satt opp. KO_PLAN_BACKUP overstyrer (tester).
 */
const SYNK = process.env.KO_PLAN_BACKUP
  ? path.resolve(process.env.KO_PLAN_BACKUP)
  : KONFIG.planBackup
    ? path.resolve(HOVEDTRE, KONFIG.planBackup)
    : null;
/**
 * `plan backup [--push] [--torr]`: kjører prosjektets backup-skript (f.eks. et skript som kopierer køen,
 * planregisteret og tidsloggen til et eget repo og committer der). Skriptet får KO_ROT = prosjektrota og flagget
 * --push videre. Ingen automatisk kjøring: foreslå den ved slutten av en økt.
 */
function planBackup() {
  const push = a.includes('--push');
  if (!SYNK)
    dø(
      'plan backup er ikke satt opp: sett "planBackup" i ko.config.json til stien til et backup-skript (node-skript ' +
        'som får KO_ROT = prosjektrota og ev. --push), eller KO_PLAN_BACKUP.',
    );
  const navn = path.basename(SYNK);
  if (!fs.existsSync(SYNK))
    dø(`Fant ikke ${SYNK} (planBackup i ko.config.json, eller KO_PLAN_BACKUP).`);
  const args = [SYNK, ...(push ? ['--push'] : [])];
  if (a.includes('--torr')) {
    console.log(
      `Forhåndsvisning (ingenting kjørt): node ${args.join(' ')} i ${path.dirname(SYNK)}, kilde ${HOVEDTRE}`,
    );
    return;
  }
  const s = spawnSync(process.execPath, args, {
    cwd: path.dirname(SYNK),
    stdio: 'inherit',
    env: { ...process.env, KO_ROT: HOVEDTRE },
  });
  if (s.error) dø(`${navn} startet ikke: ${s.error.message}`);
  if (s.status !== 0)
    dø(`${navn} stoppet (exit ${s.status}); se utskriften over.`, s.status ?? 1);
  console.log(
    push
      ? 'Backup ferdig og pushet.'
      : 'Backup ferdig (push med ko.mjs plan backup --push).',
  );
}

/**
 * `plan aktiv [<PL-id> [--slutt] [--av "…"]] [--json]`: «Arbeider nå». Med id settes markøren
 * { post, at, av } i planer.json (puls; siste vinner), med --slutt fjernes den. Samme lås og atomiske skriving som de
 * andre plan-kommandoene, men ingen endringslogg (hyppig puls, ingenting å angre) og `endret` bumpes ikke. Uten id
 * listes postene som er under arbeid nå (markøren dør etter koPlan.AKTIV_OKT_TIMER timer uten puls).
 */
function planAktiv(json) {
  const id = a[2] && !a[2].startsWith('--') ? a[2] : null;
  if (!id) {
    const aktive = P.aktivePoster(lesPlaner());
    if (json) console.log(JSON.stringify({ ok: true, aktive }));
    else if (!Object.keys(aktive).length) console.log('Ingen planposter er under arbeid nå.');
    else
      for (const [pid, m] of Object.entries(aktive))
        console.log(`${pid.padEnd(16)} av ${m.av}, siste puls ${m.at}`);
    return;
  }
  const slutt = a.includes('--slutt');
  const r = medLas(() => {
    const reg = lesPlaner();
    const s = P.settAktivOkt(reg, id, { av: avNavn(), slutt });
    if (s.feil.length) planFeil(s.feil);
    if (s.endret) skrivPlaner(reg, { bump: false });
    return s;
  });
  if (json) console.log(JSON.stringify({ ok: true, post: id, markor: r.markor, endret: r.endret }));
  else if (slutt)
    console.log(r.endret ? `${id}: markøren er fjernet.` : `${id}: hadde ingen markør.`);
  else
    console.log(
      `${id}: under arbeid (av ${r.markor.av}, ${r.markor.at}); slutt med ko.mjs plan aktiv ${id} --slutt`,
    );
}

// ---- Dokumenter og avtaler -------------------------------------------------------------------
// `plan dok …` skriver i `dokumenter` i planer.json med samme lås, --forvent-endret, endringslogg og angre som
// planpostene (endrePlaner). Logikken (validering, versjonsglipp, revisjon, «Hva må gjøres») er i koPlan.js.

/** Én linje i `plan dok vis`. */
function dokRad(d) {
  const glipp = P.versjonsglipp(d).length ? ' GLIPP' : '';
  const nr = P.nesteRevisjon(d);
  const rev = nr?.dato
    ? `rev ${nr.dato}${nr.forfalt ? ' FORFALT' : ''}`
    : nr?.hendelse
      ? 'rev ved hendelse'
      : '';
  const ver = d.versjon
    ? `v${d.versjon}${d.gjeldende_versjon && d.gjeldende_versjon !== d.versjon ? ` (gjelder ${d.gjeldende_versjon})` : ''}`
    : '';
  const prob = (d.problemer ?? []).length ? ` ${(d.problemer ?? []).length} problem` : '';
  const fast = `${d.id.padEnd(18)} ${String(d.status ?? '').padEnd(11)} ${String(d.malgruppe ?? '').padEnd(10)} ${ver.padEnd(16)} `;
  return kutt(`${fast}${d.tittel}${rev ? `  [${rev}]` : ''}${prob}${glipp}`, BREDDE);
}

/** Leser ett dokument eller en liste fra --fil. */
function lesDokFil() {
  const fil = verdi('--fil');
  if (!fil) dø('plan dok ny --fil <json> [--torr] [--json] [--satt-av agent|eier]');
  const innhold = JSON.parse(fs.readFileSync(fil, 'utf8'));
  return Array.isArray(innhold) ? innhold : [innhold];
}

function planDok(json) {
  const under = a[2];
  const ctxFor = (ko, rolle) => ({
    rolle,
    av: avNavn(),
    sporsmal: ko.sporsmal ?? {},
    finnesSti: finnesKilde,
  });
  if (under === 'vis') {
    const reg = lesPlaner();
    const filter = {
      gruppe: verdier('--gruppe'),
      status: verdier('--status'),
      malgruppe: verdier('--malgruppe'),
      prioritet: verdier('--prioritet'),
      problemer: a.includes('--problemer'),
      sok: verdi('--sok') ?? null,
      alle: a.includes('--alle'),
    };
    for (const g of filter.gruppe)
      if (!P.DOK_GRUPPER.some((x) => x.id === g))
        dø(`ukjent gruppe ${g} (${P.DOK_GRUPPER.map((x) => x.id).join(', ')})`);
    for (const st of filter.status)
      if (!P.DOK_STATUSER.includes(st)) dø(`ukjent status ${st} (${P.DOK_STATUSER.join(', ')})`);
    const treff = P.filtrerDok(reg, filter);
    const maa = P.dokMaaGjores(reg.dokumenter);
    if (json) {
      console.log(
        JSON.stringify({
          ok: true,
          endret: reg.endret ?? null,
          dokumenter: treff.map((d) => ({
            ...d,
            glipp: P.versjonsglipp(d),
            neste_revisjon: P.nesteRevisjon(d),
            grunner: P.dokGrunner(d),
          })),
          maa_gjores: maa,
          tidslinje: P.revisjonsTidslinje(reg.dokumenter, { dager: 90 }),
        }),
      );
      return;
    }
    if (!reg.dokumenter.length) {
      console.log(
        'Dokumentregisteret er tomt. Legg inn dokumenter med: ko.mjs plan dok ny --fil <json>',
      );
      return;
    }
    if (maa.length) {
      console.log('Hva må gjøres:');
      for (const m of maa)
        console.log(
          kutt(`  ${m.id.padEnd(18)} ${m.grunner.map((g) => g.tekst).join('; ')}`, BREDDE),
        );
    }
    for (const g of P.DOK_GRUPPER) {
      const liste = treff.filter((d) => d.gruppe === g.id);
      if (!liste.length) continue;
      console.log(`\n${g.tittel} (${liste.length})`);
      for (const d of liste) console.log(`  ${dokRad(d)}`);
    }
    console.log(`\n${treff.length} av ${reg.dokumenter.length} dokumenter.`);
  } else if (under === 'hent') {
    const id = a[3];
    if (!id || id.startsWith('--')) dø('plan dok hent <DOK-id> [--json]');
    const r = P.hentDok(lesPlaner(), lesKoForPlan(), id, { finnesSti: finnesKilde });
    if (r.feil.length) planFeil(r.feil);
    if (json) {
      console.log(JSON.stringify({ ok: true, ...r }));
      return;
    }
    const d = r.dok;
    console.log(`${d.id}: ${d.tittel}`);
    console.log(`Kopier: ${r.kopier}`);
    console.log(`  gruppe ${d.gruppe}, målgruppe ${d.malgruppe}, status ${d.status}`);
    console.log(
      `  versjon ${d.versjon ?? '-'}, gjeldende (akseptert) ${d.gjeldende_versjon ?? '-'}`,
    );
    if (d.kilde)
      console.log(`  kilde ${d.kilde}${r.kilde_finnes === false ? '  FINNES IKKE' : ''}`);
    for (const p of d.publisert ?? [])
      console.log(`  publisert ${p.hvor} ${p.versjon ?? ''} ${p.url ?? p.sti ?? ''}`.trimEnd());
    if (d.prioritet)
      console.log(
        `  prioritet ${d.prioritet}${d.naa_kategori?.length ? `/${d.naa_kategori.join('+')}` : ''} (${d.prioritet_satt_av}): ${d.prioritet_grunn ?? ''}`,
      );
    if (r.neste_revisjon?.dato)
      console.log(
        `  neste revisjon ${r.neste_revisjon.dato}${r.neste_revisjon.forfalt ? ' (FORFALT)' : ` (om ${r.neste_revisjon.dager} dager)`}`,
      );
    else if (r.neste_revisjon?.hendelse) console.log(`  revisjon ${r.neste_revisjon.hendelse}`);
    for (const rv of d.revisjoner ?? [])
      console.log(
        `  revidert ${rv.dato}${rv.versjon ? ` v${rv.versjon}` : ''}${rv.merknad ? `: ${rv.merknad}` : ''}`,
      );
    for (const g of r.glipp) console.log(`  VERSJONSGLIPP: ${g.tekst}`);
    for (const p of d.problemer ?? [])
      console.log(`  problem (${p.alvor}): ${p.tekst}${p.kilde ? ` [${p.kilde}]` : ''}`);
    if (r.avhenger_av.length)
      console.log(
        `  avhenger av: ${r.avhenger_av.map((x) => `${x.id} ${x.status ?? '?'}`).join(', ')}`,
      );
    if (r.brukt_av.length) console.log(`  brukt av: ${r.brukt_av.join(', ')}`);
    if (d.juridisk_punkter?.length)
      console.log(`  juridiske punkter: ${d.juridisk_punkter.join(', ')}`);
    if (r.planposter.length)
      console.log(`  planposter: ${r.planposter.map((p) => p.id).join(', ')}`);
    for (const s of r.eierspm)
      console.log(
        `  eierspm ${s.id}${s.avklart ? ' (avklart)' : ''}${s.tekst ? `: ${kutt(s.tekst, BREDDE - 20)}` : ''}`,
      );
    for (const g of r.grunner) console.log(`  MÅ GJØRES: ${g.tekst}`);
  } else if (under === 'ny') {
    const liste = lesDokFil();
    const rolle = planRolle();
    const r = endrePlaner('plan dok ny', (reg, ko) => {
      const feil = [];
      const advarsler = [];
      const nye = [];
      for (const inn of liste) {
        const s = P.nyDok(reg, inn, ctxFor(ko, rolle));
        feil.push(...s.feil);
        advarsler.push(...s.advarsler);
        if (s.dok) nye.push(s.dok.id);
      }
      return { feil, advarsler, nye };
    });
    planSvar(r, `${r.nye.length} nytt/nye dokument(er): ${r.nye.join(', ')}`);
  } else if (under === 'endre') {
    const id = a[3];
    if (!id || id.startsWith('--'))
      dø('plan dok endre <DOK-id> [--felt navn=verdi …] [--sett \'{"felt":…}\'] [--torr] [--json]');
    const t = P.tolkFeltArg(verdier('--felt'));
    if (t.feil.length) dø(t.feil.join('\n'));
    let felt = t.felt;
    if (verdi('--sett') != null) {
      try {
        felt = { ...felt, ...JSON.parse(verdi('--sett')) };
      } catch (e) {
        dø(`--sett er ikke gyldig JSON: ${e.message}`);
      }
    }
    if (!Object.keys(felt).length) dø("ingen felt å endre (--felt navn=verdi eller --sett '{…}')");
    const rolle = planRolle();
    const r = endrePlaner('plan dok endre', (reg, ko) =>
      P.endreDok(reg, id, felt, ctxFor(ko, rolle)),
    );
    planSvar(r, `Endret ${id}${r.loft ? ' (løftet til naa/sikkerhet etter regel 1)' : ''}`);
  } else if (under === 'revider') {
    const id = a[3];
    if (!id || id.startsWith('--'))
      dø(
        'plan dok revider <DOK-id> [--versjon v] [--dato YYYY-MM-DD] [--merknad "…"] [--torr] [--json]',
      );
    const rolle = planRolle();
    const r = endrePlaner('plan dok revider', (reg, ko) =>
      P.reviderDok(
        reg,
        id,
        {
          versjon: verdi('--versjon') ?? null,
          dato: verdi('--dato') ?? null,
          merknad: verdi('--merknad') ?? null,
          av: avNavn(),
        },
        ctxFor(ko, rolle),
      ),
    );
    planSvar(r, `Revisjon registrert for ${id}`);
  } else if (under === 'sjekk') {
    planDokSjekk(json);
  } else if (under === 'nett') {
    planDokNett(json).catch((e) => dø(`plan dok nett feilet: ${e?.message ?? e}`));
  } else {
    dø('Bruk: ko.mjs plan dok <vis|hent|ny|endre|revider> …  (se toppen av fila)', under ? 1 : 0);
  }
}

function planKommando() {
  const under = a[1];
  const json = a.includes('--json');
  if (under === 'vis') {
    const ko = lesKoForPlan();
    const reg = lesPlaner();
    const filter = {
      modul: verdi('--modul') ?? null,
      prosjekt: verdi('--prosjekt') ?? null,
      prioritet: verdier('--prioritet'),
      modenhet: verdier('--modenhet'),
      sok: verdi('--sok') ?? null,
      alle: a.includes('--alle'),
    };
    for (const p of filter.prioritet)
      if (!P.PRIORITETER.includes(p)) dø(`ukjent prioritet ${p} (${P.PRIORITETER.join(', ')})`);
    for (const m of filter.modenhet)
      if (!P.MODENHETER.includes(m)) dø(`ukjent modenhet ${m} (${P.MODENHETER.join(', ')})`);
    const poster = P.filtrerPoster(reg, ko, filter);
    const skjult =
      filter.alle || filter.prioritet.includes('dropp')
        ? 0
        : reg.poster.filter((p) => p.prioritet === 'dropp').length;
    if (json) {
      console.log(
        JSON.stringify({
          ok: true,
          endret: reg.endret ?? null,
          poster,
          skjult_dropp: skjult,
          aktive: P.aktivePoster(reg),
        }),
      );
      return;
    }
    if (!reg.poster.length) {
      console.log('Planregisteret er tomt. Legg inn poster med: ko.mjs plan ny --fil <json>');
      return;
    }
    let forrige = null;
    for (const p of poster) {
      const gruppe = `${p.modul ?? '(uten modul)'} / ${p.prosjekt}`;
      if (gruppe !== forrige) console.log(`\n${gruppe}`);
      forrige = gruppe;
      console.log(`  ${planRad(p)}`);
    }
    console.log(
      `\n${poster.length} av ${reg.poster.length} poster${skjult ? `; ${skjult} droppet er skjult (--alle)` : ''}.`,
    );
  } else if (under === 'hent') {
    const noekkel = a[2];
    if (!noekkel || noekkel.startsWith('--')) dø('plan hent <id|prosjekt|modul> [--json]');
    const r = P.hent(lesPlaner(), lesKoForPlan(), noekkel, { finnesSti: finnesKilde });
    if (r.feil.length) planFeil(r.feil);
    if (json) {
      console.log(JSON.stringify({ ok: true, ...r }));
      return;
    }
    console.log(
      `${r.type} ${r.noekkel}${r.tittel ? `: ${r.tittel}` : ''} (${r.poster.length} poster)`,
    );
    console.log(`Kopier: ${r.kopier}`);
    for (const p of r.poster) {
      console.log(`\n${planRad(p)}`);
      if (p.kort) console.log(`  ${p.kort}`);
      if (p.prioritet_grunn)
        console.log(`  Prioritet (${p.prioritet_satt_av}): ${p.prioritet_grunn}`);
      if (p.dropp_grunn) console.log(`  Droppet: ${p.dropp_grunn}`);
      if (p.agent_loft)
        console.log(`  Løftet av agent ${p.agent_loft.at} (var ${p.agent_loft.fra.prioritet})`);
      if (p.maalt_regel && p.maalt_regel.prioritet !== p.prioritet)
        console.log(
          `  Regel ${p.maalt_regel.nr} (${p.maalt_regel.navn}) peker på ${p.maalt_regel.prioritet}: ${p.maalt_regel.grunn}`,
        );
      for (const k of p.kilder)
        console.log(
          `  kilde ${k.sti}${k.anker ? ` ${k.anker}` : ''}${k.rolle ? ` (${k.rolle})` : ''}${k.finnes === false ? '  FINNES IKKE' : ''}`,
        );
      if (p.ko.length)
        console.log(`  kø: ${p.ko.map((o) => `${o.id} ${o.status ?? '?'}`).join(', ')}`);
      for (const s of p.eiersporsmal)
        console.log(
          `  eierspm ${s.id}${s.avklart ? ' (avklart)' : ''}${s.tekst ? `: ${kutt(s.tekst, BREDDE - 20)}` : ''}`,
        );
      if (p.avhenger?.length) console.log(`  avhenger av: ${p.avhenger.join(', ')}`);
      if (p.blokkerer.length) console.log(`  blokkerer: ${p.blokkerer.join(', ')}`);
      if (p.verifisert)
        console.log(
          `  verifisert ${p.verifisert.dato} av ${p.verifisert.av}${p.verifisert.commit ? ` (${p.verifisert.commit})` : ''}: ${p.verifisert.funn}`,
        );
      if (p.juridisk) console.log(`  juridisk: ${kutt(JSON.stringify(p.juridisk), BREDDE - 12)}`);
    }
  } else if (under === 'ny') {
    const fil = verdi('--fil');
    if (!fil) dø('plan ny --fil <json> [--torr] [--json] [--satt-av agent|eier]');
    const innhold = JSON.parse(fs.readFileSync(fil, 'utf8'));
    const liste = Array.isArray(innhold) ? innhold : [innhold];
    const rolle = planRolle();
    const r = endrePlaner('plan ny', (reg, ko) => {
      const feil = [];
      const advarsler = [];
      const nye = [];
      for (const inn of liste) {
        const s = P.nyPost(reg, inn, {
          rolle,
          prosjekter: ko.prosjekter ?? {},
          sporsmal: ko.sporsmal ?? {},
          finnesSti: finnesKilde,
        });
        feil.push(...s.feil);
        advarsler.push(...s.advarsler);
        if (s.post) nye.push(s.post.id);
      }
      return { feil, advarsler, nye };
    });
    planSvar(r, `${r.nye.length} ny(e) planpost(er): ${r.nye.join(', ')}`);
  } else if (under === 'endre') {
    const id = a[2];
    if (!id || id.startsWith('--'))
      dø('plan endre <id> [--felt navn=verdi …] [--sett \'{"felt":…}\'] [--torr] [--json]');
    const t = P.tolkFeltArg(verdier('--felt'));
    if (t.feil.length) dø(t.feil.join('\n'));
    let felt = t.felt;
    if (verdi('--sett') != null) {
      let s;
      try {
        s = JSON.parse(verdi('--sett'));
      } catch (e) {
        dø(`--sett er ikke gyldig JSON: ${e.message}`);
      }
      felt = { ...felt, ...s };
    }
    if (!Object.keys(felt).length) dø("ingen felt å endre (--felt navn=verdi eller --sett '{…}')");
    const rolle = planRolle();
    const r = endrePlaner('plan endre', (reg, ko) =>
      P.endrePost(reg, id, felt, {
        rolle,
        av: avNavn(),
        prosjekter: ko.prosjekter ?? {},
        sporsmal: ko.sporsmal ?? {},
        finnesSti: finnesKilde,
      }),
    );
    planSvar(
      r,
      `Endret ${id}${r.loft ? ' (løftet til naa/sikkerhet etter regel 1; vises i innboksen)' : ''}`,
    );
  } else if (under === 'prioriter') {
    const pos = forFlagg(2);
    const prioritet = pos.pop();
    if (!pos.length || !prioritet)
      dø(
        'plan prioriter <id…> <naa|eier|senere|dropp> [--kategori sikkerhet for-prod viktig] [--grunn "…"] [--torr] [--json]',
      );
    const rolle = planRolle();
    const r = endrePlaner('plan prioriter', (reg, ko) =>
      P.prioriter(
        reg,
        pos,
        { prioritet, kategori: verdier('--kategori'), grunn: verdi('--grunn') ?? null },
        {
          rolle,
          av: avNavn(),
          prosjekter: ko.prosjekter ?? {},
          sporsmal: ko.sporsmal ?? {},
          finnesSti: finnesKilde,
        },
      ),
    );
    planSvar(
      r,
      `Prioritet ${prioritet}: ${r.endret.length} endret${r.uendret.length ? `, ${r.uendret.length} uendret` : ''}` +
        `${r.loft.length ? `; løftet etter regel 1: ${r.loft.join(', ')}` : ''}`,
    );
  } else if (under === 'prioriter-mange') {
    // Hele utkastet fra prioritetskartet i én skriving (én lås, én endringslogg-post, én angre).
    const fil = verdi('--fil');
    if (!fil)
      dø(
        'plan prioriter-mange --fil <json> [--torr] [--forvent-endret <iso>] [--satt-av agent|eier] [--json]',
      );
    let liste;
    try {
      liste = JSON.parse(fs.readFileSync(fil, 'utf8'));
    } catch (e) {
      planFeil([`kunne ikke lese ${fil}: ${e.message}`], 1);
    }
    const rolle = planRolle();
    const r = endrePlaner('plan prioriter-mange', (reg, ko) =>
      P.prioriterMange(reg, liste, {
        rolle,
        av: avNavn(),
        prosjekter: ko.prosjekter ?? {},
        sporsmal: ko.sporsmal ?? {},
        finnesSti: finnesKilde,
      }),
    );
    planSvar(
      r,
      `Prioriteter: ${r.endret.length} endret${r.uendret.length ? `, ${r.uendret.length} uendret` : ''}` +
        `${r.loft.length ? `; løftet etter regel 1: ${r.loft.join(', ')}` : ''}`,
    );
  } else if (under === 'slaa-sammen') {
    const pos = forFlagg(2);
    const [til, ...fra] = pos;
    if (!til || !fra.length) dø('plan slaa-sammen <til-id> <fra-id…> [--torr] [--json]');
    const r = endrePlaner('plan slaa-sammen', (reg) => P.slaaSammen(reg, til, fra));
    planSvar(r, `Slo sammen ${fra.join(', ')} inn i ${til} (de andre ligger i arkivet)`);
  } else if (under === 'verifiser') {
    const id = a[2];
    if (!id || id.startsWith('--') || verdi('--funn') == null)
      dø('plan verifiser <id> --funn "…" [--commit <sha>] [--torr] [--json]');
    const commit =
      verdi('--commit') ?? (String(gitLes(['rev-parse', '--short', 'HEAD']) ?? '').trim() || null);
    const rolle = planRolle();
    const r = endrePlaner('plan verifiser', (reg, ko) =>
      P.verifiser(
        reg,
        id,
        { funn: verdi('--funn'), commit, rolle },
        { prosjekter: ko.prosjekter ?? {}, sporsmal: ko.sporsmal ?? {}, finnesSti: finnesKilde },
      ),
    );
    planSvar(r, `Verifiserte ${id}`);
  } else if (under === 'angre') {
    // Som `ko.mjs angre`, men for planregisterets egen endringslogg.
    const tekstFor = (p) =>
      `nr. ${p.nr} ${p.handling} av ${p.av} ${p.at} (${p.endringer.length} felt)`;
    const nrFeil = (reg) => {
      if (verdi('--nr') == null) return null;
      const siste = P.sisteAngrbare(reg);
      return siste && String(siste.nr) === String(verdi('--nr'))
        ? null
        : `den siste endringen som kan angres er ${siste ? `nr. ${siste.nr}` : 'ingen'}, ikke nr. ${verdi('--nr')}; ingenting angret`;
    };
    if (a.includes('--vis')) {
      const reg = lesPlaner();
      const nf = nrFeil(reg);
      const s = nf ? { feil: [nf], post: P.sisteAngrbare(reg) } : P.angre(reg, { vis: true });
      if (json)
        console.log(JSON.stringify({ ok: !s.feil.length, feil: s.feil, post: s.post ?? null }));
      else {
        if (s.post) console.log(`Siste som kan angres: ${tekstFor(s.post)}`);
        console.log(
          s.feil.length
            ? `Kan IKKE angres nå:\n  ${s.feil.join('\n  ')}`
            : 'Kan angres (ko.mjs plan angre).',
        );
      }
      return;
    }
    const r = medLas(() => {
      const reg = lesPlaner();
      const fe = P.forventSjekk(reg, verdi('--forvent-endret') ?? null);
      if (fe) planFeil([fe], fe.startsWith('ugyldig') ? 1 : 6);
      const nf = nrFeil(reg);
      const s = nf ? { feil: [nf] } : P.angre(reg, { av: avNavn() });
      if (s.feil.length) planFeil(s.feil);
      skrivPlaner(reg);
      return s;
    });
    if (json) console.log(JSON.stringify({ ok: true, post: r.post }));
    else {
      console.log(`Angret ${tekstFor(r.post)}:`);
      for (const l of planDiffLinjer(
        r.post.endringer.map((e) => ({ ...e, for: e.etter, etter: e.for })),
      ))
        console.log(`  ${l}`);
    }
  } else if (under === 'aktiv') {
    planAktiv(json);
  } else if (under === 'regler') {
    if (json) console.log(JSON.stringify({ ok: true, regler: P.PRIORITETSREGLER }));
    else
      for (const r of P.PRIORITETSREGLER)
        console.log(
          `${r.nr}. ${r.navn} → ${r.prioritet}${r.kategorier.length ? `/${r.kategorier.join(' eller ')}` : ''}: ${r.treffer}`,
        );
  } else if (under === 'sjekk') {
    planSjekk(json);
  } else if (under === 'moduler') {
    planModuler(json);
  } else if (under === 'backup') {
    planBackup();
  } else if (under === 'dok') {
    planDok(json);
  } else {
    dø(
      'Bruk: ko.mjs plan <vis|hent|ny|endre|prioriter|prioriter-mange|slaa-sammen|verifiser|angre|aktiv|regler|sjekk|moduler|backup|dok> …  (se toppen av fila)',
      under ? 1 : 0,
    );
  }
}

function loggTid(id, hendelse, merknad) {
  try {
    execFileSync(
      process.execPath,
      [
        path.join(ROT, 'scripts', 'orkestrator', 'logg-tid.mjs'),
        'ko',
        id,
        hendelse,
        '--merknad',
        merknad,
      ],
      {
        stdio: 'ignore',
      },
    );
  } catch {
    /* tidsloggen er et hjelpemiddel; køen skal ikke stoppe om den feiler */
  }
}

/**
 * Høyeste migrasjonsnummer i konfig().migrasjoner.mappe (første gruppe i filmonster), eller 0 når migrasjonsflyten er
 * av eller mappa mangler. Brukes av init og neste-migr.
 */
function hoyesteMigr(rot = HOVEDTRE) {
  if (!MIGR.mappe) return 0;
  const dir = path.join(rot, MIGR.mappe);
  const monster = new RegExp(MIGR.filmonster ?? '^(\d+)_.*\.sql$');
  let maks = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const f of fs.readdirSync(dir)) {
    const m = monster.exec(f);
    if (m && Number.isSafeInteger(Number(m[1]))) maks = Math.max(maks, Number(m[1]));
  }
  return maks;
}

const minutter = (fra, til) => Math.round((Date.parse(til) - Date.parse(fra)) / 60_000);

/**
 * Dagens forbruk i USD (norsk døgn), bare når et dagsbudsjett er satt (ellers leses ikke loggen). Kan loggen ikke
 * leses, er forbruket ukjent: det meldes på stderr (budsjettvakten kan da ikke slå til), og tallet blir 0.
 */
function dagsforbrukFor(ko) {
  if (ko?.grenser?.dagsbudsjett == null) return undefined;
  try {
    const rader = TK.lesRader(fs.readFileSync(TIDSLOGG, 'utf8'));
    return TK.dagsforbruk(rader, TK.dagFor(new Date().toISOString()));
  } catch (e) {
    console.error(
      `ADVARSEL: fant ikke forbruket i ${TIDSLOGG} (${e?.code ?? e?.message}); budsjettvakten regner med 0 USD i dag.`,
    );
    return 0;
  }
}

// ---- Orkestratorens rutine som skript og kost per oppgave ----------------------------------------------
// Agenttranskriptene: ~/.claude/projects/<repo-slug>/<økt>/subagents/agent-<agent_id>.jsonl (samme kilde som
// hook-tid.mjs). KO_TRANSKRIPTER overstyrer (tester).
const TRANSKRIPTER =
  process.env.KO_TRANSKRIPTER ??
  path.join(os.homedir(), '.claude', 'projects', HOVEDTRE.replace(/[^A-Za-z0-9]/g, '-'));
// Som i hook-tid.mjs: enorme transkripter analyseres ikke (tidsloggens siste rad brukes da).
const MAKS_TRANSKRIPT = 300 * 1024 * 1024;

/** Stien til transkriptet for en agent, eller null. */
function finnTranskript(agentId) {
  let okter;
  try {
    okter = fs.readdirSync(TRANSKRIPTER, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return null;
  }
  for (const d of okter) {
    const sti = path.join(TRANSKRIPTER, d.name, 'subagents', `agent-${agentId}.jsonl`);
    if (fs.existsSync(sti)) return sti;
  }
  return null;
}

/** Transkriptteksten, eller null når fila mangler eller er for stor. */
function lesTranskript(sti) {
  try {
    if (!sti || fs.statSync(sti).size > MAKS_TRANSKRIPT) return null;
    return fs.readFileSync(sti, 'utf8');
  } catch {
    return null;
  }
}

/** Radene i tidsloggen (tom liste når den ikke kan leses). */
function lesTidslogg() {
  try {
    return TK.lesRader(fs.readFileSync(TIDSLOGG, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Agentene som hørte til oppgaven, med transkriptet når det finnes: de sikre fra tidsloggen, pluss de usikre (ukjent
 * spor-etikett) når oppdraget deres nevner oppgave-id-en (koLogikk.agenterForOppgave og nevnerOppgave).
 */
function oppgaveAgenter(o, til = new Date().toISOString()) {
  const fra = o.startet ?? o.plukket_at ?? o.lagt_til ?? null;
  const { sikre, usikre } = L.agenterForOppgave(lesTidslogg(), o.id, { fra, til });
  const ut = [];
  for (const a of [...sikre, ...usikre.map((x) => ({ ...x, usikker: true }))]) {
    const sti = finnTranskript(a.agent);
    const tekst = lesTranskript(sti);
    // Reviewerens oppdrag nevner oppgaven bare i stien «rev-<id>\reviewer-…», som nevnerOppgave ikke ser
    // (bindestreken foran id-en); tidKost.sporFraTekst kjenner stien.
    const forsteMelding = tekst ? L.forsteBrukermelding(tekst) : null;
    const nevner =
      forsteMelding != null &&
      (L.nevnerOppgave(forsteMelding, o.id) ||
        TK.oppgaveIdFor(TK.sporFraTekst(forsteMelding) ?? '', (x) => x === o.id) === o.id);
    if (a.usikker && !nevner) continue;
    ut.push({ ...a, sti, tekst });
  }
  return ut;
}

/** Kosten for oppgaven (koLogikk.summerKost): transkriptet når det finnes, ellers den siste raden i tidsloggen. */
function maalKost(agenter) {
  return L.summerKost(
    agenter.map((a) => {
      if (a.tekst) {
        const t = TK.analyserTranskript(a.tekst);
        return {
          agent: a.agent,
          type: a.type,
          tokens: t.tokens,
          modell: t.modell,
          turer: t.modellturer,
          kilde: 'transkript',
        };
      }
      return {
        agent: a.agent,
        type: a.type,
        tokens: a.rad.tokens,
        modell: a.rad.modell,
        turer: a.rad.modellturer,
        kilde: 'tidslogg',
      };
    }),
  );
}

/** Det siste svaret fra den siste sporagenten (spor eller spor-d), eller null. */
function sisteSporsvar(agenter) {
  const spor = agenter
    .filter((a) => TK.erByggeagent(a.type))
    .sort((x, y) => Date.parse(y.rad.tid) - Date.parse(x.rad.tid));
  for (const a of spor) {
    const s = a.tekst ? L.sisteSvar(a.tekst) : null;
    if (s) return s;
  }
  return null;
}

/** Git med stor buffer (diffene i review-pakken); null ved feil. `buffer: true` gir bytene (git show av en fil). */
function gitStor(args, { buffer = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: GIT_ROT,
      encoding: buffer ? 'buffer' : 'utf8',
      maxBuffer: 1 << 28,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/** Orkestratorens scratchpad: --scratchpad, ellers KO_SCRATCHPAD, ellers `reserve` (lagret på oppgaven). */
function scratchpadFor(reserve = null) {
  const s = verdi('--scratchpad') ?? process.env.KO_SCRATCHPAD ?? reserve;
  return s ? path.resolve(s) : null;
}

/** Feltene `start` og `fyll` setter (under låsen): status, gren og ev. migrasjonsblokk. */
function markerStartet(ko, o, { agent = null, head = null, scratchpad = null } = {}) {
  const b = L.tildelMigrBlokk(ko.neste_migr, L.migrTiere(o, MIGR), MIGR.blokkStorrelse);
  if (b.fra != null) ko.neste_migr = b.nesteLedig;
  o.status = 'kjorer';
  o.startet = new Date().toISOString();
  o.gren = grenFor(o.id);
  o.agent = agent ?? o.agent ?? null;
  o.migr_blokk = L.migrBlokkTekst(b);
  // HEAD på basegrenen ved start (--bolge-base til flett-spor) og scratchpaden (motta finner rapporten der).
  if (head) o.head_start = head;
  if (scratchpad) o.scratchpad = scratchpad;
  return o;
}

/** Tidsloggraden for en start (samme for start og fyll). */
function loggStart(r) {
  loggTid(
    r.id,
    'start',
    `klasse=${r.klasse} vekt=${L.VEKT[r.klasse]} anslag=${L.anslag(r)} migr=${r.migr_blokk ?? 'ingen'} domene=${r.domene}`,
  );
}

/**
 * Sporblokkene (lag-oppdrag.mjs-format) for kjørende eller plukkede oppgaver, med advarselen om endringer utenfor
 * køen. Felles for `sporfil` og `fyll`.
 */
function lagSporBlokker(ko, idListe) {
  // Er eierfilene endret utenfor køen siden oppgaven ble lagt inn? Da får sporblokka en advarsel, så sporet
  // leser diffen før det bygger på et utdatert oppdrag.
  const varsler = G.eksternForOppgaver(
    gitLes,
    idListe
      .map((id) => ko.oppgaver.find((x) => x.id === id))
      .filter((o) => o && (o.status === 'kjorer' || o.status === 'plukket')),
  );
  const blokker = idListe.map((id) => {
    const o = ko.oppgaver.find((x) => x.id === id);
    if (!o) dø(`Ukjent oppgave ${id}`);
    if (o.status !== 'kjorer' && o.status !== 'plukket')
      dø(
        `${id} er ikke startet eller plukket (kjør \`start ${id}\` eller \`plukk ${id} --av …\` først)`,
      );
    // Oppdragsfilene (<dataMappe>/oppdrag/) er gitignorert og finnes bare i hovedtreet; en som har plukket
    // oppgaven, kjører gjerne dette fra sitt eget worktree.
    const kildeSti = oppdragFil(o);
    const tekst = kildeSti ? fs.readFileSync(kildeSti, 'utf8') : o.oppdrag;
    const blokk =
      o.migr_blokk ??
      (MIGR.mappe
        ? 'ingen (sporet skal ikke ha migrasjoner; trengs det, spør orkestratoren)'
        : 'ingen (prosjektet har ingen migrasjonsflyt)');
    // Selve blokka (eierskap, advarselen, eierens svar og oppdraget) er delt med sky-pakke.
    return [
      `=====${o.id}=====`,
      `TITTEL: SPOR ${o.id} (${o.tittel})`,
      `BLOKK: ${blokk}`,
      `GREN: ${o.gren}`,
      '',
      L.sporBlokk(o, ko, { tekst, advarsel: varsler.get(o.id)?.advarsel ?? null }),
    ].join('\n');
  });
  const medVarsel = [...varsler].filter(([, v]) => v.advarsel).map(([id]) => id);
  return { blokker, medVarsel };
}

/**
 * Målingen ved `sett ferdig` og `kost maal`: kosten, funnene (reviewernes FUNN-linjer, eller --funn) og
 * RESULTAT-linja (når den ikke er lagret av `motta`; --resultat overstyrer).
 */
function maalOppgave(o) {
  const agenter = oppgaveAgenter(o);
  const kost = maalKost(agenter);
  const funnFlagg = verdier('--funn');
  const funn = funnFlagg.length
    ? L.samleFunn(funnFlagg.map((f) => L.parseFunn(f)))
    : L.samleFunn(
        agenter
          .filter((x) => L.REVIEWER_TYPER.includes(x.type) && x.tekst)
          .map((x) => L.parseFunn(L.sisteSvar(x.tekst))),
      );
  const resultatTekst = verdi('--resultat') ?? (o.resultat ? null : sisteSporsvar(agenter));
  return { kost, funn, resultat: resultatTekst ? L.parseResultat(resultatTekst) : null };
}

/**
 * Reviewernes FUNN-linjer for oppgaven (siste svar i hvert reviewertranskript), til `--funn` når `flett`
 * kaller `sett ferdig`. Tom liste når ingen reviewer har en FUNN-linje (feltet utelates da, uten feil).
 */
function reviewerFunnLinjer(o) {
  return oppgaveAgenter(o)
    .filter((x) => L.REVIEWER_TYPER.includes(x.type) && x.tekst)
    .map((x) => L.parseFunn(L.sisteSvar(x.tekst)))
    .filter(Boolean)
    .map((f) => f.linje);
}

function lagreMaaling(o, m) {
  o.kost = m.kost;
  if (m.funn) o.funn = m.funn;
  if (m.resultat) o.resultat = m.resultat;
}

/** «Kost X: $12.3 (3 agent(er), 25.1 mill. tokens, 140 turer) · funn H=0 M=1 L=2 (1 rapport(er))». */
function maalingLinje(o) {
  const k = o.kost;
  const mill = (k.tokens.sum / 1e6).toFixed(1);
  return (
    `Kost ${o.id}: $${k.usd} (${k.agenter.length} agent(er), ${mill} mill. tokens, ${k.turer} turer)` +
    (o.funn
      ? ` · funn H=${o.funn.H} M=${o.funn.M} L=${o.funn.L} (${o.funn.rapporter} rapport(er))`
      : ' · ingen FUNN-linje funnet') +
    (o.resultat ? ` · RESULTAT ${o.resultat.status ?? '?'}` : '')
  );
}

/** «7d», «24t», «90m» eller en dato/ISO-tid → ISO-tid; null når ingenting er gitt. */
function sidenTid(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d+)\s*([dtm])$/i);
  if (m) {
    const ms = { d: 86_400_000, t: 3_600_000, m: 60_000 }[m[2].toLowerCase()];
    return new Date(Date.now() - Number(m[1]) * ms).toISOString();
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) dø(`Ukjent tid «${s}» (bruk f.eks. 7d, 24t eller 2026-10-01).`);
  return new Date(t).toISOString();
}

// ---- Kommandoer ----------------------------------------------------------------------------------------------
if (kmd === 'init') {
  // Lager datamappa og en tom kø med standardgrenser og eksempelprosjektet «eksempel» (prefiks EKS-). En eksisterende
  // kø røres aldri, så init er trygg å kjøre flere ganger.
  fs.mkdirSync(MAPPE, { recursive: true });
  if (fs.existsSync(FIL)) {
    console.log(`Køen finnes allerede: ${FIL} (ingenting endret).`);
    process.exit(0);
  }
  const ko = {
    opprettet: new Date().toISOString(),
    grenser: {
      maksSamtidig: Number(verdi('--maks-samtidig') ?? L.STANDARD_GRENSER.maksSamtidig),
      maksDPluss: Number(verdi('--maks-dpluss') ?? L.STANDARD_GRENSER.maksDPluss),
      maksPerDomene: Number(verdi('--maks-per-domene') ?? L.STANDARD_GRENSER.maksPerDomene),
    },
    avklart: [],
    prosjekter: {
      eksempel: {
        tittel: 'Eksempel',
        prefikser: ['EKS-'],
      },
    },
    oppgaver: [],
  };
  // Migrasjonsblokker bare når migrasjonsflyten er slått på (konfig().migrasjoner.mappe).
  if (MIGR.mappe) ko.neste_migr = Number(verdi('--neste-migr') ?? hoyesteMigr() + 1);
  else if (verdi('--neste-migr') != null)
    console.log('Merk: --neste-migr ignoreres; migrasjonsflyten er av (migrasjoner.mappe i ko.config.json).');
  medLas(() => skriv(ko));
  console.log(
    `Køen er laget: ${FIL}` +
      (ko.neste_migr != null ? ` (neste migrasjonsblokk fra ${ko.neste_migr})` : '') +
      '. Eksempelprosjektet «eksempel» (prefiks EKS-) kan gis nytt navn med ko.mjs prosjekt.',
  );
} else if (kmd === 'add') {
  const kilde = verdi('--fil') ? fs.readFileSync(verdi('--fil'), 'utf8') : verdi('--json');
  if (!kilde) dø("add krever --fil <oppgave.json> eller --json '{...}'");
  const innhold = JSON.parse(kilde);
  // { "oppgaver": [...], "sporsmal": {...} } legger inn oppgavene og teksten til spørsmålene de venter på i
  // samme skriving. Et objekt uten id med ett av disse feltene er den formen; ellers er det én oppgave (som før).
  const samlet =
    innhold &&
    typeof innhold === 'object' &&
    !Array.isArray(innhold) &&
    innhold.id === undefined &&
    ('oppgaver' in innhold || 'sporsmal' in innhold);
  const nye = samlet ? [].concat(innhold.oppgaver ?? []) : [].concat(innhold);
  const nyeSporsmal = samlet ? (innhold.sporsmal ?? {}) : {};
  if (samlet && !nye.length && !Object.keys(nyeSporsmal ?? {}).length)
    dø('Ingenting å legge til (både oppgaver og sporsmal er tomme).');
  const godkjent = a.includes('--godkjent');
  // --plan <id> kobler oppgavene (som ikke har eget `plan`) til en planpost. Satt i fila eller med --plan:
  // planposten må finnes i planregisteret (en ukjent eller sammenslått post nektes), og posten blir i-ko av seg selv.
  const planArg = a.includes('--plan') ? verdi('--plan') : null;
  if (a.includes('--plan') && (!planArg || planArg.startsWith('--')))
    dø('--plan krever en planpost-id (ko.mjs plan vis)');
  const lagt = endre((ko) => {
    const feil = [];
    let planAdvarsler = [];
    if (planArg || nye.some((n) => n?.plan != null)) {
      // Under samme lås som køen, så registeret ikke endres mellom sjekken og skrivingen.
      const k = P.koblePlan(lesPlaner(), nye, planArg);
      feil.push(...k.feil);
      planAdvarsler = k.advarsler;
      nye.splice(0, nye.length, ...k.oppgaver);
    }
    // Spørsmålene valideres sammen med oppgavene: alt eller ingenting.
    const sp = L.settSporsmal(ko, nyeSporsmal);
    feil.push(...sp.feil.map((f) => `sporsmal ${f}`));
    for (const n of nye) {
      // valider sjekker også at id-en ikke finnes i køen fra før, og (når registeret har prosjekter) at et
      // eksplisitt prosjekt finnes.
      const f = L.valider(n, ko.oppgaver, ko.prosjekter);
      if (f.length) feil.push(`${n.id ?? '(uten id)'}: ${f.join('; ')}`);
    }
    if (new Set(nye.map((n) => n.id)).size !== nye.length)
      feil.push('samme id to ganger i det som legges til');
    // Hver venter_paa-id må være et registrert spørsmål (tekst og type), fra før eller i samme fil
    // (settSporsmal over har lagt dem i ko.sporsmal; ingenting skrives når feil ikke er tom). Fritekst avvises.
    if (!sp.feil.length)
      for (const n of nye) {
        const f = L.venterPaaFeil(n, ko);
        if (f.length) feil.push(`${n.id ?? '(uten id)'}: ${f.join('; ')}`);
      }
    // Reglene for samlekøen mot køen slik den blir (de nye kan avhenge av hverandre).
    const etter = [...ko.oppgaver, ...nye.map((n) => ({ status: 'venter', ...n }))];
    for (const n of nye) {
      const f = L.samlesFeil({ status: 'venter', ...n }, etter, ko.avklart);
      if (f.length) feil.push(`${n.id ?? '(uten id)'}: ${f.join('; ')}`);
      // Småoppgavevakten (fiks nå, samlekøen, eller spør eieren om prioriteten).
      const s = L.smaaoppgaveFeil({ status: 'venter', ...n }, etter, ko.avklart);
      if (s.length) feil.push(`${n.id ?? '(uten id)'}: ${s.join('; ')}`);
    }
    if (feil.length) dø(`Ingenting lagt til:\n  ${feil.join('\n  ')}`);
    const resultat = [];
    for (const n of nye) {
      // En agent (spor, reviewer, fold-/utredningsagent) legger inn forslag, ikke arbeid som startes av seg selv.
      // Statusen regnes mot køen FØR de nye legges til (en ny oppgave kan ikke gjøre en annen til agentkilde).
      const status = L.statusVedAdd(n, ko.oppgaver, { godkjent });
      resultat.push({ id: n.id, status });
      ko.oppgaver.push({
        nytte: 5,
        innhold_min: 30,
        migr_tiere: 0,
        avhenger: [],
        venter_paa: [],
        eier_filer: [],
        eier_db: [],
        delt_patch: [],
        ...n,
        status,
        lagt_til: new Date().toISOString(),
      });
    }
    // Nye oppgaver skal ha prosjekt og funksjon. Mangler de, sies det fra nå, ikke når en senere utfylling stopper
    // på dem.
    const ider = new Set(nye.map((n) => n.id));
    const mangler = L.manglerProsjekt(
      ko.oppgaver.filter((o) => ider.has(o.id)),
      ko.prosjekter,
    );
    // Et spørsmål uten tekst kan ikke vises i «Venter på deg» med noe eieren kan svare på.
    const utenTekst = L.sporsmalUtenTekst(nye, ko);
    // Forslag til prosjekt (lengste prefiks, plan, filrot) og uenighet med et eksplisitt prosjekt.
    const prosjektAdvarsler = L.addProsjektAdvarsler(nye, ko.prosjekter);
    // Et prosjekt i fase plan har ingen køoppgaver; får det oppgaver nå, tas fasen bort i samme skriving.
    const faseAvsluttet = P.fasePlanAvsluttes(ko.prosjekter, nye);
    for (const pid of faseAvsluttet) {
      const resten = { ...ko.prosjekter[pid] };
      delete resten.fase;
      ko.prosjekter[pid] = resten;
    }
    return {
      resultat,
      mangler,
      sporsmal: sp.satt,
      utenTekst,
      prosjektAdvarsler,
      planAdvarsler,
      faseAvsluttet,
    };
  });
  const venter = lagt.resultat.filter((r) => r.status === 'venter').map((r) => r.id);
  const forslag = lagt.resultat.filter((r) => r.status === 'forslag').map((r) => r.id);
  if (venter.length) console.log(`Lagt til: ${venter.join(', ')}`);
  if (forslag.length)
    console.log(
      `Lagt til som forslag (startes ikke før orkestratoren eller eieren godkjenner: ko.mjs godkjenn <id…>): ${forslag.join(', ')}`,
    );
  const { utenProsjekt, utenFunksjon } = lagt.mangler;
  if (utenProsjekt.length || utenFunksjon.length)
    console.log(
      `ADVARSEL: ${[
        utenProsjekt.length
          ? `uten prosjekt (havner i ${L.UTEN_PROSJEKT}): ${utenProsjekt.join(', ')}`
          : null,
        utenFunksjon.length ? `uten funksjon: ${utenFunksjon.join(', ')}` : null,
      ]
        .filter(Boolean)
        .join(
          '; ',
        )}. Rett med ko.mjs endre-mange --fil <json> ([{ "id": "…", "prosjekt": "…", "funksjon": "…" }]).`,
    );
  for (const x of lagt.prosjektAdvarsler) console.log(`ADVARSEL: ${x}`);
  for (const x of lagt.planAdvarsler) console.log(`ADVARSEL: ${x}`);
  const koblet = [...new Set(nye.map((n) => n?.plan).filter(Boolean))];
  if (koblet.length) console.log(`Koblet til planpost: ${koblet.join(', ')} (i-ko av seg selv)`);
  if (lagt.faseAvsluttet.length)
    console.log(`Fase plan tatt bort (har køoppgaver nå): ${lagt.faseAvsluttet.join(', ')}`);
  if (lagt.sporsmal.length) console.log(`Spørsmålstekst satt: ${lagt.sporsmal.join(', ')}`);
  if (lagt.utenTekst.length)
    console.log(
      `ADVARSEL: spørsmål uten tekst (vises uten tekst i «Venter på deg»): ${lagt.utenTekst.join(', ')}. ` +
        'Legg dem i "sporsmal" i add-fila, eller: ko.mjs sporsmal <id> --tekst "…" --type <type>.',
    );
} else if (
  kmd === 'vis' &&
  !['--full', '--alle', '--gruppert', '--prosjekt'].some((f) => a.includes(f))
) {
  // Kort visning som standard (aktive, startbare og tellinger, under ca. 3 000 tegn); den fulle tabellen var
  // ca. 66 000 tegn (ca. 20 000 tokens per kall). `--kort` godtas også. Den fulle: `vis --full`.
  const ko = les();
  for (const l of L.kortVisning(ko, {
    ucommittet: ucommittetStier(),
    dagsforbruk: dagsforbrukFor(ko),
    bredde: BREDDE,
    markor: lesMarkor(),
  }))
    console.log(l);
  // Løse ventinger (fritekst eller uregistrert spørsmål, eller et svar som likevel blokkerer).
  for (const l of L.loseVentingerLinjer(L.loseVentinger(ko), { maks: 5 })) console.log(l);
} else if (kmd === 'vis') {
  const ko = les();
  const alle = a.includes('--alle');
  const register = ko.prosjekter ?? {};
  const pid = verdi('--prosjekt');
  const iProsjekt = (o) => !pid || L.prosjektFor(o, register) === pid;
  const ucommittet = ucommittetStier();
  // Felles rangering (fokustrinn, så score); parkerte og hindringene «utenfor fokus»/«parkert» fra samme kilde.
  const rk = L.rangeringKontekst(ko);
  // En ventende oppgave uten andre hindringer som eier en ucommittet fil, hoppes over av `neste`; si hvorfor.
  const hindringerFor = (o) => {
    const h = L.hindringerMedPause(o, ko, rk);
    const u = h.length ? null : L.ucommittetKollisjon(o, ucommittet);
    return u ? [`fil ${u.sti} er ucommittet i hovedtreet`] : h;
  };
  const medTrinn = rk.gjelder || ko.oppgaver.some((o) => L.parkertNaa(o, rk.naa));
  const rader = ko.oppgaver
    .filter((o) => o.status !== 'forslag' && !L.erEksternRad(o) && !L.iSamlekoen(o))
    .filter((o) => alle || !['ferdig', 'kansellert'].includes(o.status))
    .filter(iProsjekt)
    .map((o) => {
      const r = o.status === 'venter' ? L.rangering(o, ko, rk) : null;
      return { o, r, s: r ? r.score : null, h: o.status === 'venter' ? hindringerFor(o) : [] };
    })
    // Som før: ventende etter prioritet øverst, så resten (kjorer, plukket, review, ferdig) i køens rekkefølge. Med fokus
    // eller parkerte sorteres de ventende først etter trinn (parkerte sist blant dem).
    .sort(
      (x, y) =>
        (medTrinn ? (x.r?.trinn ?? 3e6) - (y.r?.trinn ?? 3e6) : 0) || (y.s ?? -1) - (x.s ?? -1),
    );
  const under = (tekst, innrykk) => {
    console.log(`${' '.repeat(innrykk)}↳ ${kutt(tekst, BREDDE - innrykk - 2)}`);
  };
  if (a.includes('--gruppert')) {
    // Tre: prosjekt → funksjon → oppgaver, smalt nok for et smalt terminalvindu.
    for (const p of L.grupper(
      rader.map((r) => r.o),
      register,
    )) {
      const hode = `${p.pid}${p.tittel ? `  ${p.tittel}` : ''}${p.pause ? '  [PAUSE]' : ''}`;
      console.log(kutt(hode, BREDDE));
      for (const f of p.funksjoner) {
        console.log(`  ${kutt(f.funksjon, BREDDE - 2)}`);
        for (const o of f.oppgaver) {
          const r = rader.find((x) => x.o === o);
          const kol = `    ${o.id.padEnd(12)} ${o.status.padEnd(8)} ${o.klasse.padEnd(2)} ${`${L.anslag(o)}m`.padEnd(5)} `;
          console.log(kol + kutt(o.tittel, BREDDE - kol.length));
          if (o.status === 'plukket') under(plukkLinje(o), 6);
          else if (r.h.length) under(r.h.join(' · '), 6);
        }
      }
    }
  } else {
    for (const { o, s, h, r } of rader) {
      const kol = [
        o.id.padEnd(12),
        o.status.padEnd(9),
        o.klasse.padEnd(3),
        o.domene.padEnd(14),
        `${L.anslag(o)} min`.padEnd(8),
        s == null ? '        ' : String(s).padEnd(8),
        // Trinnet (T2 …, resten) bare når fokus gjelder, så tabellen ellers er som før.
        ...(rk.gjelder
          ? [(r ? (r.parkert ? 'parkert' : L.stegTekst(r).split(' ')[0]) : '').padEnd(7)]
          : []),
        o.tittel,
      ];
      console.log(kol.join(' '));
      if (o.status === 'plukket') console.log(`${' '.repeat(13)}↳ ${plukkLinje(o)}`);
      else if (h.length) console.log(`${' '.repeat(13)}↳ ${h.join(' · ')}`);
      if (r?.dratt_av) console.log(`${' '.repeat(13)}↳ dratt med av ${r.dratt_av} (i fokus)`);
    }
  }
  // Forslag for seg: de startes ikke før de er godkjent.
  const forslag = ko.oppgaver
    .filter((o) => o.status === 'forslag' && !L.iSamlekoen(o))
    .filter(iProsjekt);
  if (forslag.length) {
    console.log(
      `\nFORSLAG (${forslag.length}, startes ikke før de er godkjent: ko.mjs godkjenn <id…>):`,
    );
    for (const o of forslag.sort((x, y) => Number(y.nytte ?? 5) - Number(x.nytte ?? 5))) {
      console.log(
        [
          o.id.padEnd(12),
          o.klasse.padEnd(3),
          o.domene.padEnd(14),
          `${L.anslag(o)} min`.padEnd(8),
          `nytte ${o.nytte ?? 5}`.padEnd(9),
          `fra ${o.lagt_til_av ?? '?'}`.padEnd(16),
          o.tittel,
        ].join(' '),
      );
    }
  }
  // Samlekøen for seg (startes ikke alene; pakkes med ko.mjs samle pakk).
  const samleGr = L.samleGrupper(ko).filter((g) => !pid || g.pid === pid);
  if (samleGr.length) {
    const n = samleGr.reduce((s, g) => s + g.antall, 0);
    const klare = samleGr.filter((g) => g.klar).length;
    console.log(
      `\nSAMLEKØEN (${n} oppgave(r) i ${samleGr.length} gruppe(r)${klare ? `, ${klare} klar(e) til pakking` : ''}; ` +
        'startes ikke alene, se ko.mjs samle):',
    );
    for (const g of samleGr) console.log(kutt(`  ${samleGruppeLinje(g)}`, BREDDE));
  }
  // Arbeid registrert utenfor køen (ekstern add) for seg; det eier filer, men er ikke arbeid i køen.
  const registrert = ko.oppgaver.filter((o) => L.erEksternRad(o) && o.status === 'ekstern');
  if (registrert.length) {
    console.log(
      `\nUTENFOR KØEN (${registrert.length}, registrert med ekstern add; eier filene til ko.mjs ekstern ferdig "<navn>"):`,
    );
    for (const o of registrert) {
      const alder = o.lagt_til ? L.alderTekst(Date.now() - Date.parse(o.lagt_til)) : '?';
      const eier = [...(o.eier_filer ?? []), ...(o.eier_db ?? [])].join(', ');
      console.log(
        kutt(
          `${o.id.padEnd(24)} «${o.ekstern_navn}» for ${alder} siden · ${eier}${o.gren ? ` · gren ${o.gren}` : ''}`,
          BREDDE,
        ),
      );
    }
  }
  const forbruk = dagsforbrukFor(ko);
  const t = L.tilstand(ko, forbruk, { ucommittet, markor: lesMarkor() });
  console.log(`\n${L.tilstandLinje(t)}`);
  if (t.fokus)
    console.log(kutt(`FOKUS${t.fokus.navn ? ` «${t.fokus.navn}»` : ''}: ${t.fokus.tekst}`, BREDDE));
  if (t.fokus?.varsel) console.log(`VARSEL: ${t.fokus.varsel}`);
  const b = L.budsjettVakt(ko, forbruk);
  if (b.aktiv) console.log(b.melding);
  const n = L.nattVakt(ko);
  if (n.aktiv) console.log(n.melding);
  // Løse ventinger (fritekst eller uregistrert spørsmål, eller et svar som likevel blokkerer).
  for (const l of L.loseVentingerLinjer(L.loseVentinger(ko), { maks: 50 })) console.log(l);
} else if (kmd === 'neste') {
  const ko = les();
  // Budsjettvakt: over dagsbudsjettet foreslås ingenting (exit 4, så en løkke ikke tar det for «tom kø»).
  // Nattvakt: nattkjøring av og inne i nattvinduet gir exit 5 av samme grunn.
  // Avviklingsvakt: orkestratoren i avvikling (hook-kontekst, ca. 350k) gir exit 6.
  const forbruk = dagsforbrukFor(ko);
  const vakt = L.startVakt(ko, forbruk, { markor: lesMarkor() });
  if (vakt) dø(vakt.melding, vakt.kode);
  const b = L.budsjettVakt(ko, forbruk);
  // Oppgaver som eier en ucommittet fil i hovedtreet, hoppes over (en annen økt jobber i fila).
  const ucommittet = ucommittetStier();
  const valgt = L.velgNeste(ko, Date.now(), { ucommittet });
  if (!valgt.length) console.log('Ingenting kan startes nå (se `vis` og `tilstand`).');
  for (const v of valgt)
    console.log(
      `${v.id.padEnd(12)} ${v.klasse.padEnd(3)} ${v.domene.padEnd(14)} ${v.anslag} min  prioritet ${v.score}` +
        (v.prosjekt !== L.UTEN_PROSJEKT ? `  (${v.prosjekt})` : '') +
        ('steg' in v ? `  ${L.stegTekst(v)}` : ''),
    );
  // Varsel når fokusperioden er ute eller fokuset ikke har noe klart.
  const fokusSt = L.fokusStatus(ko, { kanStarte: valgt.map((v) => v.id) });
  if (fokusSt?.varsel) console.log(`VARSEL: ${fokusSt.varsel}`);
  const hoppet = L.ucommittetHoppet(ko, ucommittet);
  if (hoppet.length) {
    console.log(
      `Hoppet over ${hoppet.length} (eierfil ucommittet i hovedtreet; en annen økt jobber i den):`,
    );
    for (const h of hoppet.slice(0, 10)) console.log(`  ${h.id.padEnd(12)} fil ${h.sti}`);
    if (hoppet.length > 10) console.log(`  … og ${hoppet.length - 10} til`);
    console.log(
      '  Vent, be økta committe eller registrere seg (ko.mjs ekstern add), eller start --tving på eierens ord.',
    );
  }
  if (b.aktiv) console.log(b.melding);
} else if (kmd === 'start') {
  const id = a[1];
  if (!id) dø('start <id>');
  // Forbruket leses før låsen (loggen er stor nok til at det ikke skal skje med køfila låst). Det samme gjelder
  // git status (ucommittede filer i hovedtreet).
  const forbruk = dagsforbrukFor(les());
  const ucommittet = ucommittetStier();
  const r = endre((ko) => {
    const o = ko.oppgaver.find((x) => x.id === id);
    if (!o) dø(`Ukjent oppgave ${id}`);
    const h = L.hindringer(o, ko.oppgaver, ko.avklart);
    if (h.length) dø(`${id} kan ikke startes: ${h.join(' · ')}`);
    // Budsjettvakt (exit 4) og nattvakt (exit 5): --tving (eierens ord) overstyrer, som for de andre
    // grensene.
    const vakt = L.startVakt(ko, forbruk, { tving: a.includes('--tving'), markor: lesMarkor() });
    if (vakt) dø(vakt.melding, vakt.kode);
    // --tving: eieren har bedt om at oppgaven går først. Overstyrer bare prioritetsrekkefølgen i velgNeste og
    // pausen på prosjektet, aldri hindringene over (avhengigheter, eierskap, eierspørsmål).
    if (
      !a.includes('--tving') &&
      !L.velgNeste(ko, Date.now(), { ucommittet }).some((v) => v.id === id)
    ) {
      const register = ko.prosjekter ?? {};
      // Parkert og utenfor fokus (resten venter) stopper som pause; --tving (eierens ord) overstyrer.
      const plass = L.fokusPlass(o, L.rangeringKontekst(ko));
      if (plass.parkert)
        dø(`${id} kan ikke startes: ${plass.grunn}. Eller start --tving på eierens ord.`);
      if (L.prosjektPauset(o, register)) {
        const pid = L.prosjektFor(o, register);
        dø(
          `${id} hører til prosjektet ${pid}, som er pauset (ko.mjs prosjekt ${pid} --fortsett, eller start --tving).`,
        );
      }
      if (plass.ut)
        dø(
          `${id} kan ikke startes: ${plass.grunn}. Endre fokus (ko.mjs fokus sett …), eller start --tving på eierens ord.`,
        );
      const u = L.ucommittetKollisjon(o, ucommittet);
      if (u)
        dø(
          `${id} kan ikke startes: fil ${u.sti} er ucommittet i hovedtreet (en annen økt jobber i den). Vent, be økta ` +
            'committe eller registrere seg (ko.mjs ekstern add), eller start --tving på eierens ord.',
        );
      dø(
        `${id} er ikke blant dem som kan startes nå (grensene for samtidige, D+ eller domene er nådd). Se \`neste\`.`,
      );
    }
    return markerStartet(ko, o, {
      agent: verdi('--agent'),
      head: git(['rev-parse', BASE]),
      scratchpad: scratchpadFor(),
    });
  });
  loggStart(r);
  console.log(
    `Startet ${id}: gren ${r.gren}${r.migr_blokk ? `, migrasjonsblokk ${r.migr_blokk}` : ''}, anslag ${L.anslag(r)} min.`,
  );
  // Tenkenivå etter klasse: K og U på `spor` (medium), D og D+ på `spor-d` (high).
  console.log(
    L.agentTypeFor(r.klasse) === 'spor-d'
      ? 'Agent: subagent_type spor-d (tenkenivå high).'
      : 'Agent: subagent_type spor (tenkenivå medium).',
  );
  // Bare orkestratoren starter oppgaver: markøren sier at den er aktiv.
  pulsMarkor(`start ${id}`);
  skrivEksternVarsel(r);
} else if (kmd === 'sett') {
  const [, id, status] = a;
  if (!id || !status) dø('sett <id> <status>');
  let qa = false;
  // Orkestrator-markøren oppdateres når køens egne oppgaver flyttes; ikke for en plukket oppgave (den som
  // plukket, kan sette den ferdig selv) eller en registrering utenfor køen.
  let orkestratorSteg = false;
  // Ved `ferdig` måles kosten (agentenes usage fra transkriptene) og funnene fra reviewernes
  // FUNN-linje (eller --funn "FUNN H=… M=… L=…", kan gjentas), og RESULTAT-linja hentes når `motta` ikke tok den.
  // Lesingen skjer før låsen; mislykkes den, settes oppgaven ferdig likevel (målingen stopper aldri køen).
  let maaling = null;
  if (status === 'ferdig' && !a.includes('--uten-kost')) {
    try {
      const o = les().oppgaver.find((x) => x.id === id);
      if (o && !L.erEksternRad(o)) maaling = maalOppgave(o);
    } catch (e) {
      console.error(
        `ADVARSEL: kunne ikke måle kosten for ${id} (${e?.message ?? e}); settes ferdig uten.`,
      );
    }
  }
  const r = endre((ko) => {
    const o = ko.oppgaver.find((x) => x.id === id);
    if (!o) dø(`Ukjent oppgave ${id}`);
    orkestratorSteg = !o.plukket_av && !L.erEksternRad(o);
    const naa = new Date().toISOString();
    // settStatus: levert/ferdig-tid, qa_status «venter» for en visuell oppgave som blir ferdig, og plukk-feltene
    // fjernes når en plukket oppgave settes tilbake til venter.
    const s = L.settStatus(o, status, naa);
    if (s.feil) dø(s.feil);
    qa = s.qa;
    if (verdi('--merknad')) o.merknader = [...(o.merknader ?? []), `${naa} ${verdi('--merknad')}`];
    if (maaling) lagreMaaling(o, maaling);
    return o;
  });
  if (maaling) console.log(maalingLinje(r));
  if (status === 'review' && r.startet)
    loggTid(id, 'levert', `${minutter(r.startet, r.levert)} min til levering`);
  if (status === 'ferdig' && r.startet) {
    loggTid(
      id,
      'ferdig',
      `${minutter(r.startet, r.ferdig)} min totalt${r.levert ? `, ${minutter(r.levert, r.ferdig)} min review/fletting` : ''}; ${verdi('--merknad') ?? ''}`,
    );
  }
  console.log(
    `${id}: ${status}${qa ? ' · etiketten visuell: står nå i eierens QA-liste (ko.mjs qa)' : ''}`,
  );
  if (orkestratorSteg) pulsMarkor(`sett ${id} ${status}`);
} else if (kmd === 'endre') {
  const [, id] = a;
  const felt = JSON.parse(verdi('--json') ?? '{}');
  // --tillegg "<tekst>" legger tekst til oppdraget (sporblokka) og merknadene, med tidsstempel.
  const tillegg = a.includes('--tillegg') ? (verdi('--tillegg') ?? '') : null;
  if (tillegg != null && !String(tillegg).trim())
    dø('endre <id> --tillegg "<tekst>": tillegget er tomt.');
  // Feltene tillegg og merknader føres bare av --tillegg (og sett --merknad).
  delete felt.tillegg;
  // Statusfelt og plukk-feltene endres bare med sine kommandoer (sett, plukk, lever, slipp).
  for (const f of [
    'id',
    'status',
    'lagt_til',
    'startet',
    'ferdig',
    'gren',
    'migr_blokk',
    'plukket_av',
    'plukket_at',
    // En registrering utenfor køen blir aldri en oppgave, og omvendt.
    'ekstern',
    'ekstern_navn',
    'gjort_utenfor_koen',
  ])
    delete felt[f];
  endreLogget('endre', (ko) => {
    const o = ko.oppgaver.find((x) => x.id === id);
    if (!o) dø(`Ukjent oppgave ${id}`);
    const ny = { ...o, ...felt };
    const f = L.valider(
      ny,
      ko.oppgaver.filter((x) => x.id !== id),
      ko.prosjekter,
    );
    // Samles (inn i eller ut av samlekøen) og avhenger mot en oppgave i samlekøen.
    f.push(
      ...L.samlesFeil(
        ny,
        ko.oppgaver.map((x) => (x.id === id ? ny : x)),
        ko.avklart,
      ),
    );
    // En ny venter_paa-id må være et registrert spørsmål (ko.mjs sporsmal <id> --tekst … først).
    f.push(...L.venterPaaFeil(ny, ko, { tidligere: o.venter_paa ?? [] }));
    if (f.length) dø(`Ugyldig endring: ${f.join('; ')}`);
    Object.assign(o, felt);
    // `samles: false` tar oppgaven ut av samlekøen; feltet fjernes så køfila ser ut som før.
    if (o.samles === false) delete o.samles;
    if (tillegg != null) {
      const t = L.leggTilTillegg(o, tillegg, new Date().toISOString());
      if (t) dø(`Ugyldig tillegg: ${t}`);
    }
  });
  const endretFelt = [...Object.keys(felt), ...(tillegg != null ? ['tillegg', 'merknader'] : [])];
  console.log(`${id} endret: ${endretFelt.join(', ')}`);
  if (tillegg != null)
    console.log(
      'Tillegget står i sporblokka fra nå (ko.mjs sporfil / fyll --ider). Kjører sporet allerede: send det med SendMessage.',
    );
  if (angreHint()) console.log(angreHint());
} else if (kmd === 'avklar') {
  const sp = posisjonelle(1, ['--svar', '--av']);
  if (!sp.length) dø('avklar <spørsmål> [...] [--svar "…"] [--av "…"]');
  // Med tidsstempel (og svaret, når det er gitt) i `avklaringer`; id-ene står i `avklart` som før.
  const svar = a.includes('--svar') ? (verdi('--svar') ?? '') : null;
  const lagt = endre((ko) => {
    const naa = new Date().toISOString();
    const r = L.avklar(ko, sp, { svar, av: verdi('--av') ?? null, naa });
    if (r.feil.length) dø(`Ingenting avklart:\n  ${r.feil.join('\n  ')}`);
    // Svaret skrives inn i oppdraget til hver oppgave som venter på spørsmålet (idempotent).
    return L.eiersvarTillegg(ko, sp, svar, naa);
  });
  console.log(`Avklart: ${sp.join(', ')}${svar != null ? ' (med svar)' : ''}`);
  if (lagt.length)
    console.log(
      `Svaret er lagt inn i oppdraget (EIERSVAR-tillegg) for: ${[...new Set(lagt.map((x) => x.id))].join(', ')}. ` +
        'Kjører et spor allerede: send det med SendMessage.',
    );
} else if (kmd === 'avklaringer') {
  if (a.includes('--merk-logget')) {
    const sp = posisjonelle(1);
    const r = endre((ko) => {
      const s = L.merkLogget(ko, sp);
      if (s.feil.length) dø(`Ingenting merket:\n  ${s.feil.join('\n  ')}`);
      return s;
    });
    console.log(`Ført i beslutningsloggen: ${r.merket.join(', ')}`);
  } else {
    const ko = les();
    const bareUlogget = a.includes('--ulogget');
    const rader = bareUlogget
      ? L.ulogget(ko)
      : Object.entries(ko.avklaringer ?? {})
          .map(([sp, x]) => ({ sp, ...x }))
          .sort((x, y) => String(x.tid).localeCompare(String(y.tid)));
    if (!rader.length)
      console.log(
        bareUlogget ? 'Ingen uloggede avklaringer.' : 'Ingen avklaringer med tidsstempel ennå.',
      );
    for (const r of rader) {
      const q = ko.sporsmal?.[r.sp];
      const merke = r.svar == null ? 'uten svar' : r.logget ? 'logget' : 'IKKE LOGGET';
      console.log(`${r.sp}  ${r.tid ?? '?'}  av ${r.av ?? '?'}  [${merke}]`);
      if (q?.tekst) console.log(`  ${q.type ?? 'sporsmal'}: ${q.tekst}`);
      if (r.svar != null) console.log(`  svar: ${r.svar}`);
      if (q?.kilde) console.log(`  kilde: ${q.kilde}`);
    }
    if (bareUlogget && rader.length)
      console.log(
        `\nFør svarene i beslutningsloggen (og planen spørsmålet står i), commit med --trailer "Ko: orkestrator", ` +
          `så: ko.mjs avklaringer --merk-logget ${rader.map((r) => r.sp).join(' ')}`,
      );
  }
} else if (kmd === 'sporsmal') {
  const fil = verdi('--fil');
  const [id] = posisjonelle(1, ['--fil', '--tekst', '--type', '--anbefaling', '--kilde']);
  const felter = ['--tekst', '--type', '--anbefaling', '--kilde'].some((f) => a.includes(f));
  if (fil || id || felter) {
    if (!fil && !id) dø('sporsmal <id> --tekst "…" [--type …] [--anbefaling "…"] [--kilde "…"]');
    let inn;
    if (fil) inn = JSON.parse(fs.readFileSync(fil, 'utf8'));
    else {
      // Bare feltene som er gitt, sendes videre; resten beholdes fra før.
      const felt = {};
      for (const k of ['tekst', 'type', 'anbefaling', 'kilde'])
        if (a.includes(`--${k}`)) felt[k] = verdi(`--${k}`) ?? '';
      inn = { [id]: felt };
    }
    const r = endre((ko) => {
      const s = L.settSporsmal(ko, inn);
      if (s.feil.length) dø(`Ingenting endret (${s.feil.length} feil):\n  ${s.feil.join('\n  ')}`);
      return s;
    });
    if (!r.satt.length) console.log('Ingenting å sette (tomt objekt).');
    else console.log(`Spørsmål satt (${r.satt.length}): ${r.satt.join(', ')}`);
  } else {
    const ko = les();
    const rader = L.sporsmalOversikt(ko);
    if (!rader.length) console.log('Ingen eierspørsmål i køen.');
    for (const r of rader) {
      const status = r.avklart
        ? 'avklart'
        : `åpen, ${r.oppgaver.length} ${r.oppgaver.length === 1 ? 'oppgave venter' : 'oppgaver venter'}`;
      console.log(kutt(`${r.sp}  [${r.type}; ${status}]`, BREDDE));
      console.log(
        `  ${kutt(r.tekst ?? '(mangler tekst: ko.mjs sporsmal <id> --tekst "…")', BREDDE - 2)}`,
      );
      if (r.anbefaling) console.log(`  ${kutt(`anbefaling: ${r.anbefaling}`, BREDDE - 2)}`);
    }
  }
} else if (kmd === 'godkjenn') {
  const ider = a.slice(1).filter((x) => !x.startsWith('--'));
  if (!ider.length) dø('godkjenn <id> [...]');
  const r = endre((ko) => {
    const svar = L.godkjenn(ko, ider);
    // Alt eller ingenting: en skrivefeil i én id skal ikke godkjenne halve lista.
    if (svar.feil.length) dø(`Ingenting godkjent:\n  ${svar.feil.join('\n  ')}`);
    return svar;
  });
  console.log(`Godkjent (venter nå): ${r.godkjent.join(', ')}`);
} else if (kmd === 'grense') {
  const [, navn, raa] = a;
  if (navn) {
    // Valideres under låsen mot grensene slik de er nå (maksDPluss høyst maksSamtidig).
    const t = endre((ko) => {
      const r = L.tolkGrense(navn, raa, { ...L.STANDARD_GRENSER, ...(ko.grenser ?? {}) });
      if ('feil' in r) dø(r.feil);
      ko.grenser = { ...(ko.grenser ?? {}), [navn]: r.verdi };
      return r;
    });
    console.log(`${navn} = ${L.grenseTekst(navn, t.verdi)}`);
  }
  const ko = les();
  const g = { ...L.STANDARD_GRENSER, ...(ko.grenser ?? {}) };
  for (const n of L.GRENSE_NAVN) console.log(`  ${n.padEnd(14)} ${L.grenseTekst(n, g[n])}`);
  // Terskelen for lav parallellitet (ikke en plassgrense; standard i koDiagnose).
  console.log(`  ${'parallellTerskel'.padEnd(14)} ${D.terskelFor(ko)}`);
  const b = L.budsjettVakt(ko, dagsforbrukFor(ko));
  if (b.aktiv) console.log(b.melding);
  const natt = L.nattVakt(ko);
  if (natt.aktiv) console.log(natt.melding);
} else if (kmd === 'kompakt') {
  // ---- Komprimeringsmodus for orkestratorøkta ----
  // Samme lås og validering som `grense autokompakt`. Claude Code-siden (når økta komprimeres av seg selv) styres av
  // eieren med /autocompact i økta; denne kommandoen endrer aldri settings-filer.
  const [, ny] = a;
  if (ny) {
    endre((ko) => {
      const r = L.tolkGrense('autokompakt', ny);
      if ('feil' in r) dø(`${r.feil}. Bruk: ko.mjs kompakt [auto|manuell]`);
      ko.grenser = { ...(ko.grenser ?? {}), autokompakt: r.verdi };
      return r;
    });
  }
  const modus = KV.kompaktModus(les());
  console.log(`Komprimeringsmodus: ${KV.modusTekst(modus)}.`);
  console.log(
    modus === 'auto'
      ? `Claude Code må komprimere selv: lim inn ${KV.AUTOCOMPACT_PAA} i orkestratorøkta (én gang). Hookene sier ` +
          'fra med en reservelinje hvis det ikke skjer før avviklingen, og gjenopptar køen etter komprimeringen.'
      : `Hookene gir en ferdig /compact-linje ved ca. 280k. Har du satt ${KV.AUTOCOMPACT_PAA} tidligere, sett ` +
          `Claude Code tilbake med ${KV.AUTOCOMPACT_AV}.`,
  );
} else if (kmd === 'tilstand') {
  const ko = les();
  const t = L.tilstand(ko, dagsforbrukFor(ko), {
    ucommittet: ucommittetStier(),
    markor: lesMarkor(),
  });
  // Egen liste over løse ventinger (alltid med; tom liste når alt er i orden).
  t.loseVentinger = L.loseVentinger(ko);
  // Parallelliteten (aktive, maks, andel, terskel, lav) alltid; funnene bare når den er lav.
  const par = D.parallellDiagnose(ko);
  t.parallell = { ...par, funn: par.lav ? par.funn : [] };
  console.log(JSON.stringify(t, null, 2));
  if (t.tom) process.exit(3);
} else if (kmd === 'diagnose') {
  // ---- Hele kødiagnosen, uansett parallellitet (leser bare) ----
  const d = D.parallellDiagnose(les());
  if (a.includes('--json')) console.log(JSON.stringify(d, null, 2));
  else console.log(D.diagnoseFull(d).join('\n'));
} else if (kmd === 'sporfil') {
  const ut = verdi('--ut');
  const idListe = a.slice(1).filter((x, i, arr) => x !== '--ut' && arr[i - 1] !== '--ut');
  if (!ut || !idListe.length) dø('sporfil <id> [...] --ut <fil>');
  const ko = les();
  const { blokker, medVarsel } = lagSporBlokker(ko, idListe);
  fs.writeFileSync(ut, blokker.join('\n'));
  console.log(
    `Skrev ${blokker.length} sporblokk(er) til ${ut}. Neste: lag-oppdrag.mjs --felles <ko-felles.md> --spor ${ut} --head <sha>`,
  );
  if (medVarsel.length)
    console.log(
      `Advarsel om endringer utenfor køen står i sporblokka for: ${medVarsel.join(', ')} (ko.mjs ekstern).`,
    );
} else if (kmd === 'fyll') {
  // ---- neste → start → sporfil → lag-ko-felles → lag-oppdrag i ett kall ----
  const scratch = scratchpadFor();
  if (!scratch)
    dø('fyll --scratchpad <mappe> (eller KO_SCRATCHPAD): prompt-filene skrives dit.');
  const maks = verdi('--maks') != null ? Number(verdi('--maks')) : Infinity;
  if (!(maks >= 0)) dø('--maks må være et tall ≥ 0');
  const ider = verdier('--ider');
  // Uten --ider skal fyll bare starte nye; under avvikling nektes det før noe annet (exit 6).
  if (!ider.length) {
    const av = L.avviklingVakt(lesMarkor());
    if (av.stopp) dø(av.melding, 6);
  }
  const head = git(['rev-parse', BASE]);
  if (!head) dø(`Fant ikke basegrenen ${BASE} i hovedtreet (git rev-parse ${BASE}).`);
  const forbruk = dagsforbrukFor(les());
  const ucommittet = ucommittetStier();
  let kvoteMelding = null;
  // Under låsen: velg (velgNeste, eller --ider) og marker startet. Med --ider får en oppgave som allerede kjører,
  // bare nye prompt-filer (f.eks. etter at lag-oppdrag feilet); en ventende må kunne startes nå (ellers start --tving
  // på eierens ord først).
  const valgt = endre((ko) => {
    const ut = [];
    if (ider.length) {
      const kan = L.velgNeste(ko, Date.now(), { ucommittet }).map((v) => v.id);
      for (const id of ider) {
        const o = ko.oppgaver.find((x) => x.id === id);
        if (!o) dø(`Ukjent oppgave ${id}. Ingenting er startet.`);
        if (o.status === 'kjorer') ut.push({ o, ny: false });
        else if (o.status === 'venter' && kan.includes(id)) {
          // Avviklingen stopper også nye starter via --ider (nye prompt-filer for kjørende går fortsatt).
          const av = L.avviklingVakt(lesMarkor());
          if (av.stopp) dø(`${av.melding} Ingenting er startet.`, 6);
          ut.push({ o, ny: true });
        } else
          dø(
            `${id} (${o.status}) kan ikke startes nå (se neste og vis --full; start --tving bare på eierens ord). ` +
              'Ingenting er startet.',
          );
      }
    } else {
      const vakt = L.startVakt(ko, forbruk, { markor: lesMarkor() });
      if (vakt) dø(vakt.melding, vakt.kode);
      // Kvoteprognosen (myk). Modus varsel: bare en linje. Modus tak: høyst så mange nye at antallet spor
      // samtidig holder kvoten til neste nullstilling; --over-kvote overstyrer. En feil i prognosen stopper aldri fyll.
      let kvoteMaks = Infinity;
      try {
        const aktive = ko.oppgaver.filter((x) => x.status === 'kjorer').length;
        const t = KAP.kvoteTak(
          KAP.prognose({ ko, hendelser: TK.forbruksHendelser(lesTidslogg()) }),
          aktive,
        );
        if (t.melding) kvoteMelding = t.melding;
        if (t.grense != null && !a.includes('--over-kvote')) kvoteMaks = t.grense;
      } catch (e) {
        kvoteMelding = `(Kvoteprognosen feilet: ${e?.message ?? e}; ko.mjs kapasitet)`;
      }
      for (const v of L.velgNeste(ko, Date.now(), { ucommittet }).slice(
        0,
        Math.min(maks, kvoteMaks),
      ))
        ut.push({ o: ko.oppgaver.find((x) => x.id === v.id), ny: true });
    }
    for (const x of ut) if (x.ny) markerStartet(ko, x.o, { head, scratchpad: scratch });
    return ut.map((x) => ({ id: x.o.id, ny: x.ny }));
  });
  // Kontroll ved hver fylling: løse ventinger (eieren ser dem ikke, eller et svar blokkerer likevel).
  const loseVarsel = () => {
    for (const l of L.loseVentingerLinjer(L.loseVentinger(les()), { maks: 10 })) console.log(l);
  };
  if (kvoteMelding) console.log(kvoteMelding);
  if (!valgt.length) {
    console.log('Ingenting kan startes nå (se vis og tilstand).');
    loseVarsel();
    parallellVarsel();
    process.exit(0);
  }
  const ko = les();
  for (const v of valgt.filter((x) => x.ny)) loggStart(ko.oppgaver.find((x) => x.id === v.id));
  pulsMarkor(`fyll ${valgt.map((v) => v.id).join(' ')}`);
  fs.mkdirSync(scratch, { recursive: true });
  const sporFil = path.join(scratch, 'ko-spor-fyll.md');
  const fellesFil = path.join(scratch, 'ko-felles.md');
  const { blokker, medVarsel } = lagSporBlokker(
    ko,
    valgt.map((v) => v.id),
  );
  fs.writeFileSync(sporFil, blokker.join('\n'));
  const nyeIder = valgt.filter((v) => v.ny).map((v) => v.id);
  const kjorSkript = (navn, args) => {
    try {
      execFileSync(process.execPath, [path.join(ROT, 'scripts', 'orkestrator', navn), ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      });
    } catch (e) {
      dø(
        `${navn} feilet: ${String(e?.stderr ?? e?.message ?? e).trim()}\n` +
          (nyeIder.length ? `Startet (kjorer): ${nyeIder.join(', ')}. ` : '') +
          `Når feilen er rettet: ko.mjs fyll --ider ${valgt.map((v) => v.id).join(' ')} --scratchpad "${scratch}"`,
      );
    }
  };
  // Felles-protokollen lages hver gang (billig), så en endret oppdragsmal alltid er med.
  kjorSkript('lag-ko-felles.mjs', ['--ut', fellesFil, '--scratchpad', scratch]);
  kjorSkript('lag-oppdrag.mjs', [
    '--felles',
    fellesFil,
    '--spor',
    sporFil,
    '--head',
    head,
    '--ut',
    scratch,
  ]);
  const spor = valgt.map((v) => {
    const o = ko.oppgaver.find((x) => x.id === v.id);
    const prompt = path.join(scratch, `prompt-${o.id}.md`);
    return {
      id: o.id,
      klasse: o.klasse,
      subagent_type: L.agentTypeFor(o.klasse),
      prompt,
      melding: L.sporMelding(o.id, prompt),
      gren: o.gren,
      migr_blokk: o.migr_blokk ?? null,
      ny: v.ny,
      advarsel: medVarsel.includes(o.id),
    };
  });
  const jsonFil = path.join(scratch, 'ko-fyll.json');
  fs.writeFileSync(
    jsonFil,
    JSON.stringify({ tid: new Date().toISOString(), head, spor }, null, 2) + '\n',
  );
  console.log(`FYLT ${spor.length} spor (head ${head.slice(0, 8)}); detaljene i ${jsonFil}.`);
  for (const s of spor)
    console.log(
      `${s.id}  subagent_type=${s.subagent_type}  migr ${s.migr_blokk ?? '-'}${s.ny ? '' : '  (kjørte fra før)'}` +
        `${s.advarsel ? '  ADVARSEL i sporfila (endret utenfor køen)' : ''}`,
    );
  loseVarsel();
  // Sporene som nettopp ble startet, teller som aktive (de står som kjorer i køfila nå).
  parallellVarsel();
  // Alle agentene startes i SAMME tur (parallelle Agent-kall), ikke én per tur.
  for (const l of L.samtidigBlokk(spor)) console.log(l);
} else if (kmd === 'motta') {
  // ---- Et spor har levert → review + review-pakke som vanlige filer + reviewer-prompt ----
  const id = posisjonelle(1, ['--scratchpad', '--resultat'])[0];
  if (!id) dø('motta <id> [--scratchpad <mappe>] [--resultat "RESULTAT …"] [--tving]');
  const o0 = les().oppgaver.find((x) => x.id === id);
  if (!o0) dø(`Ukjent oppgave ${id}`);
  if (!['kjorer', 'plukket', 'review'].includes(o0.status))
    dø(`${id} har status ${o0.status}; motta gjelder kjorer, plukket eller review.`);
  const scratch = scratchpadFor(o0.scratchpad ?? null);
  if (!scratch) dø('motta trenger --scratchpad <mappe> (eller KO_SCRATCHPAD).');
  const gren = o0.gren ?? grenFor(id);
  const gi = grenInfo(gren);
  if (!gi.finnes) dø(`Grenen ${gren} finnes ikke.`);
  if (gi.commits === 0 && !a.includes('--tving'))
    dø(
      `${gren} har ingen commits foran ${BASE} (allerede flettet?). Pakken blir tom; --tving for å lage den likevel.`,
    );
  const omfang = `${BASE}...${gren}`;
  const mappe = path.join(scratch, `rev-${id}`);
  // Pakken lages på nytt hver gang (en ny runde etter retting erstatter den gamle). Bare filer vi har laget selv.
  fs.rmSync(mappe, { recursive: true, force: true });
  fs.mkdirSync(path.join(mappe, 'filer'), { recursive: true });
  const stat = gitStor(['diff', '--stat', omfang]) ?? '';
  const diff = gitStor(['diff', omfang]) ?? '';
  fs.writeFileSync(path.join(mappe, 'diff.patch'), diff);
  const { kopier, hoppet } = L.pakkeFiler(
    gitStor(['diff', '--name-status', '--no-renames', omfang]),
    gitStor(['diff', '--numstat', '--no-renames', omfang]),
  );
  const kopiert = [];
  for (const sti of kopier) {
    const innhold = gitStor(['show', `${gren}:${sti}`], { buffer: true });
    if (innhold == null) {
      hoppet.push({ sti, grunn: 'kunne ikke leses fra grenen' });
      continue;
    }
    const malFil = path.join(mappe, 'filer', ...sti.split('/'));
    fs.mkdirSync(path.dirname(malFil), { recursive: true });
    fs.writeFileSync(malFil, innhold);
    kopiert.push(sti);
  }
  // Sporets svar (fra transkriptet), rapport.md og overlevering.md fra sporets mappe i scratchpad.
  const agenter = oppgaveAgenter(o0);
  const sporsvar = sisteSporsvar(agenter);
  const filer = {};
  if (sporsvar) {
    fs.writeFileSync(path.join(mappe, 'sporsvar.md'), sporsvar);
    filer.sporsvar = true;
  }
  for (const [kilde, maal, n] of [
    ['rapport.md', 'sporrapport.md', 'rapport'],
    ['overlevering.md', 'overlevering.md', 'overlevering'],
  ]) {
    const k = path.join(scratch, id, kilde);
    if (fs.existsSync(k)) {
      fs.copyFileSync(k, path.join(mappe, maal));
      filer[n] = true;
    }
  }
  const rapportTekst = filer.rapport
    ? fs.readFileSync(path.join(mappe, 'sporrapport.md'), 'utf8')
    : null;
  const resultat =
    L.parseResultat(verdi('--resultat')) ??
    L.parseResultat(sporsvar) ??
    L.parseResultat(rapportTekst);
  const dbObjekter = L.dbObjekterFraDiff(diff, { mappe: MIGR.mappe });
  fs.writeFileSync(
    path.join(mappe, '00-pakke.md'),
    L.reviewPakkeIndeks({
      o: o0,
      gren,
      stat,
      dbObjekter,
      kopiert,
      hoppet,
      resultat,
      filer,
      base: BASE,
      migrMappe: MIGR.mappe,
    }),
  );
  const reviewere = L.reviewereFor(o0.klasse);
  const prompter = reviewere.map((type) => {
    const fil = path.join(mappe, `reviewer-${type}.md`);
    fs.writeFileSync(fil, L.reviewerPrompt({ o: o0, type, mappe, base: BASE }) + '\n');
    return { type, fil };
  });
  const r = endre((ko) => {
    const o = ko.oppgaver.find((x) => x.id === id);
    if (o.status !== 'review') {
      const s = L.settStatus(o, 'review', new Date().toISOString());
      if (s.feil) dø(s.feil);
    }
    if (resultat) o.resultat = resultat;
    o.review_pakke = mappe;
    // Første levering til review (en ny runde etter retting beholder det første tidspunktet).
    o.t_motta ??= new Date().toISOString();
    return o;
  });
  if (o0.status !== 'review' && r.startet)
    loggTid(id, 'levert', `${minutter(r.startet, r.levert)} min til levering`);
  if (!r.plukket_av) pulsMarkor(`motta ${id}`);
  console.log(
    `${id}: review · ${resultat ? resultat.linje : 'ingen RESULTAT-linje (les sporsvar.md)'}\n` +
      `Pakke: ${mappe} (00-pakke.md; ${kopiert.length} fil(er), ${dbObjekter.length} DB-objekt(er))`,
  );
  // Rapporttaket (ca. 1 500 tegn); det lange skal stå i rapport.md.
  const takVarsel = L.rapportTakVarsel(sporsvar);
  if (takVarsel) console.log(takVarsel);
  // Reviewerne (D+: to) startes i SAMME tur.
  if (prompter.length)
    for (const l of L.samtidigBlokk(
      prompter.map((p) => ({ subagent_type: p.type, prompt: p.fil })),
    ))
      console.log(l);
  else console.log(`Klasse ${o0.klasse}: ingen review (konfig().reviewere har ingen for klassen).`);
  console.log(
    `Flett (etter godkjent review, fra Bash): node scripts/orkestrator/ko.mjs flett ${id}  ` +
      `(for hånd: flett-spor.mjs ${gren} --bolge-base ${o0.head_start ?? '<HEAD ved start>'})`,
  );
  // Slutten av et spor er et naturlig sjekkpunkt for parallelliteten.
  parallellVarsel();
} else if (kmd === 'flett') {
  // ---- flett-spor → migrasjonspush (bare med migrasjonsflyt, med miljøvakt) → gater --rask → sett ferdig → fyll,
  // i ett kall. Stegene, stopp-reglene og miljøsjekken er i koLogikk (flettPlan, utforFlett, miljoSjekk); her er bare
  // I/O-en. ----
  const id = posisjonelle(1, ['--scratchpad'])[0];
  if (!id) dø('flett <id> [--uten-migr-push] [--uten-fyll] [--scratchpad <mappe>] [--tving]');
  const o = les().oppgaver.find((x) => x.id === id);
  if (!o) dø(`Ukjent oppgave ${id}`);
  const tving = a.includes('--tving');
  if (o.status !== 'review' && !(tving && ['kjorer', 'plukket'].includes(o.status)))
    dø(
      `${id} har status ${o.status}; flett gjelder review (etter motta og godkjent review). ` +
        '--tving bare for kjorer/plukket på eierens ord.',
    );
  const gren = o.gren ?? grenFor(id);
  const gi = grenInfo(gren);
  if (!gi.finnes) dø(`Grenen ${gren} finnes ikke.`);
  if (gi.commits === 0)
    dø(`${gren} har ingen commits foran ${BASE} (allerede flettet?). Ingenting gjort.`);
  const utenFyll = a.includes('--uten-fyll');
  const scratch = scratchpadFor(o.scratchpad ?? null);
  if (!scratch && !utenFyll)
    dø('flett trenger --scratchpad <mappe> (eller KO_SCRATCHPAD) for fyll, eller --uten-fyll.');
  const navn = git(['diff', '--name-only', `${BASE}...${gren}`]);
  // Grenens skillepunkt og tupp FØR flettingen. Etter flettingen er HEAD = basegrenen og gatenes diff mot base tom;
  // med disse kan gater.mjs fortsatt se sporets egne endringer.
  const sporArgs = require('./lib/sporDiff.js').sporArgs({
    skille: git(['merge-base', BASE, gren]),
    tupp: git(['rev-parse', '--verify', `refs/heads/${gren}`]),
  });
  // Størrelsen i kodelinjer (stabil størrelsesenhet), målt FØR flettingen mot bølgebasen (HEAD ved start;
  // uten den: basegrenen). Tre prikker: bare grenens egne endringer.
  const diffLinjer = TK.diffLinjerFraShortstat(
    git(['diff', '--shortstat', `${o.head_start ?? BASE}...${gren}`]),
  );
  const plan = L.flettPlan({
    o,
    filer: navn == null ? null : navn.split(/\r?\n/).filter(Boolean),
    utenMigrPush: a.includes('--uten-migr-push'),
    utenFyll,
    base: BASE,
    migrasjoner: MIGR,
  });
  const loggMappe = scratch ?? MAPPE;
  fs.mkdirSync(loggMappe, { recursive: true });
  const loggFil = path.join(loggMappe, `flett-${id}.log`);
  const loggDeler = [];
  const skrivLogg = (tekst) => {
    loggDeler.push(tekst);
    try {
      fs.writeFileSync(loggFil, loggDeler.join('\n'));
    } catch {
      /* loggen er et hjelpemiddel (Windows-fillås); stegene går videre */
    }
  };
  const koMjs = path.join(ROT, 'scripts', 'orkestrator', 'ko.mjs');
  const merknad = `flettet med ko.mjs flett${plan.migrPush ? ' (migrasjoner pushet)' : ''}`;
  /** Kommandoen for ett steg: [program, argumenter, skall?]. Migrasjonskommandoen er en skallinje fra konfigen. */
  const kommando = ({ steg }) => {
    if (steg === 'flett')
      return [
        process.execPath,
        [
          path.join(ROT, 'scripts', 'orkestrator', 'flett-spor.mjs'),
          gren,
          ...(o.head_start ? ['--bolge-base', o.head_start] : []),
        ],
      ];
    if (steg === 'migr-push') return [String(MIGR.pushKommando), [], true];
    if (steg === 'gater')
      return [
        process.execPath,
        [
          path.join(ROT, 'scripts', 'orkestrator', 'gater.mjs'),
          '--rask',
          ...sporArgs,
          '--logg',
          path.join(loggMappe, `flett-${id}-gater`),
        ],
      ];
    if (steg === 'ferdig')
      return [
        process.execPath,
        [
          koMjs,
          'sett',
          id,
          'ferdig',
          '--merknad',
          merknad,
          // Reviewernes FUNN-linjer føres inn i oppgaven (`funn`); ingen linje: ingen --funn.
          ...reviewerFunnLinjer(o).flatMap((l) => ['--funn', l]),
        ],
      ];
    if (steg === 'fyll') return [process.execPath, [koMjs, 'fyll', '--scratchpad', scratch]];
    throw new Error(`ukjent steg ${steg}`);
  };
  // Testene injiserer kjøreren (KO_FLETT_KJORER = en modul med default-eksport kjor({ steg, cmd, args }) →
  // { kode, ut }), så det aldri blir en ekte migrasjonspush, fletting eller gatekjøring i en test.
  const injisert = process.env.KO_FLETT_KJORER
    ? (await import(pathToFileURL(path.resolve(process.env.KO_FLETT_KJORER)).href)).default
    : null;
  const kjor = (x) => {
    const [cmd, args, skall = false] = kommando(x);
    let r;
    if (injisert) r = injisert({ ...x, cmd, args });
    else {
      const s = spawnSync(cmd, args, {
        cwd: GIT_ROT,
        encoding: 'utf8',
        maxBuffer: 1 << 28,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: skall,
      });
      r = {
        kode: s.status ?? 1,
        ut: `${s.stdout ?? ''}${s.stderr ?? ''}${s.error ? `\n${s.error.message}` : ''}`,
      };
    }
    skrivLogg(`===== ${x.steg}: ${cmd} ${args.join(' ')} (exit ${r.kode}) =====\n${r.ut}`);
    return r;
  };
  const PV = require('./lib/pushVakt.js');
  // Miljøfila ligger ofte gitignorert bare i hovedtreet; derfor prøves git-rota først og så hovedtreet.
  const lesMiljo = () => PV.lesMiljo([GIT_ROT, HOVEDTRE], MIGR.miljoFil ?? null);
  console.log(`FLETT ${id} (${gren}): ${plan.steg.join(' → ')}`);
  const res = L.utforFlett({
    o,
    plan,
    gren,
    gjeldendeGren: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    kjor,
    lesMiljo,
    // Push-vakta (hook-push-vakt.mjs) ser ikke kommandoer inne i dette skriptet; derfor spørres den her også.
    vakt: (miljo) =>
      PV.vurder(String(MIGR.pushKommando ?? ''), {
        gren: BASE,
        miljo,
        baseGren: BASE,
        migrasjoner: MIGR,
      }),
    base: BASE,
    migrasjoner: MIGR,
  });
  for (const l of res.linjer) console.log(l);
  if (!res.ok) {
    console.log(`STOPP i steget ${res.stopp.steg}: ${res.stopp.melding}`);
    if (res.stopp.utdrag.length) console.log(res.stopp.utdrag.map((l) => `  | ${l}`).join('\n'));
    console.log(`Full logg: ${loggFil}`);
    process.exit(1);
  }
  // Tidsstemplene og størrelsen. t_review er den første reviewer-starten etter t_motta (hook-tid skriver
  // start-raden med oppgave-id-en fra stien rev-<id>); testene kjører med injisert kjører, uten ekte fletting.
  endre((ko) => {
    const ox = ko.oppgaver.find((x) => x.id === id);
    if (!ox) return null;
    ox.t_flett = new Date().toISOString();
    if (diffLinjer != null) ox.diff_linjer = diffLinjer;
    const tReview = TK.forsteReviewStart(lesTidslogg(), id, {
      typer: L.REVIEWER_TYPER,
      fra: ox.t_motta ?? null,
    });
    if (tReview && !ox.t_review) ox.t_review = tReview;
    return ox;
  });
  console.log(`Full logg: ${loggFil}`);
} else if (kmd === 'info') {
  // ---- Faste oppslag i stedet for `node -e` mot ko.json ----
  const id = posisjonelle(1, ['--felt'])[0];
  if (!id) dø('info <id> [--felt <navn>] [--json]');
  const o = les().oppgaver.find((x) => x.id === id);
  if (!o) dø(`Ukjent oppgave ${id}`);
  const felt = verdi('--felt');
  if (felt) {
    const v = L.infoFelt(o, felt);
    if (v === undefined) dø(`${id} har ikke feltet ${felt}`);
    console.log(L.infoVerdiTekst(v));
  } else if (a.includes('--json')) console.log(JSON.stringify(o, null, 2));
  else for (const l of L.infoVisning(o)) console.log(l);
} else if (kmd === 'aktive') {
  for (const l of L.aktiveLinjer(les())) console.log(l);
} else if (kmd === 'neste-migr') {
  // Høyeste fil i hovedtreet (basegrenen, der flettede migrasjoner står) og høyeste tildelte blokk i køen.
  if (!MIGR.mappe)
    dø('Prosjektet har ingen migrasjonsflyt (konfig().migrasjoner.mappe er ikke satt); neste-migr gjelder ikke.');
  const hoyFil = hoyesteMigr(GIT_ROT);
  const nyTekst = a[1];
  if (nyTekst == null) {
    const ko = les();
    console.log(
      `neste_migr ${ko.neste_migr}; ` +
        `høyeste migrasjonsfil ${hoyFil}, høyeste blokk ${L.hoyesteBlokkNr(ko)}`,
    );
  } else {
    const ny = Number(nyTekst);
    const forrige = endre((ko) => {
      const v = L.nesteMigrVakt({
        naa: ko.neste_migr,
        ny,
        hoyesteFil: hoyFil,
        hoyesteBlokk: L.hoyesteBlokkNr(ko),
      });
      if (!v.ok) dø(`Ingenting endret: ${v.feil}`);
      const f = ko.neste_migr;
      ko.neste_migr = ny;
      return f;
    });
    console.log(`neste_migr ${forrige} → ${ny}`);
  }
} else if (kmd === 'kapasitet') {
  // ---- Ukekvoten på abonnementet (lib/koKapasitet.js; nullstilling og plannavn i konfig().kapasitet). Endringer
  // skrives under låsen i ko.json
  // (feltet `kapasitet`); visningen leser bare. ----
  const hendelser = TK.forbruksHendelser(lesTidslogg());
  const tid = verdi('--tid');
  const naa = tid ? Date.parse(tid) : Date.now();
  if (!Number.isFinite(naa)) dø('--tid må være et ISO-tidspunkt, f.eks. 2026-10-23T10:35+02:00');
  if (verdi('--kalibrer') != null) {
    const r = endre((ko) => {
      const k = KAP.kalibrer(ko, { prosent: verdi('--kalibrer'), hendelser, naa });
      if (k.feil) dø(k.feil);
      ko.kapasitet = k.kapasitet;
      return k;
    });
    console.log(`Kalibrert: usd_per_100 ${r.forrige} → ${r.kapasitet.usd_per_100}.`);
  }
  if (verdi('--sett') != null) {
    const v = Number(verdi('--sett'));
    if (!(v > 0))
      dø(
        '--sett må være et positivt tall (USD API-ekvivalent i tidsloggen per 100 % av ukekvoten)',
      );
    endre((ko) => {
      ko.kapasitet = { ...(ko.kapasitet ?? {}), usd_per_100: Math.round(v) };
    });
  }
  if (verdi('--modus') != null) {
    const m = verdi('--modus');
    if (!['varsel', 'tak', 'av'].includes(m)) dø('--modus må være varsel, tak eller av');
    endre((ko) => {
      ko.kapasitet = { ...(ko.kapasitet ?? {}), modus: m };
    });
  }
  if (verdi('--skykreditt') != null) {
    const igjen = Number(verdi('--skykreditt'));
    const total = verdi('--total') != null ? Number(verdi('--total')) : undefined;
    const utloper = verdi('--utloper');
    if (!(igjen >= 0)) dø('--skykreditt må være et tall ≥ 0 (USD igjen)');
    if (utloper && !Number.isFinite(Date.parse(utloper))) dø('--utloper må være et ISO-tidspunkt');
    endre((ko) => {
      const forrige = ko.kapasitet?.skykreditt ?? {};
      ko.kapasitet = {
        ...(ko.kapasitet ?? {}),
        skykreditt: {
          igjen_usd: igjen,
          total_usd: total ?? forrige.total_usd ?? null,
          utloper: utloper ? new Date(utloper).toISOString() : (forrige.utloper ?? null),
          satt: new Date().toISOString(),
        },
      };
    });
  }
  const p = KAP.prognose({ ko: les(), hendelser, naa });
  if (a.includes('--json')) console.log(JSON.stringify(p, null, 2));
  else console.log(KAP.linjer(p).join('\n'));
} else if (kmd === 'kost') {
  // ---- Kost per oppgave. `kost maal <id…>` måler og lagrer på nytt (f.eks. eldre ferdige). ----
  if (a[1] === 'maal') {
    const ider = posisjonelle(2, ['--funn', '--resultat']);
    if (!ider.length) dø('kost maal <id> [...]');
    for (const id of ider) {
      const o = les().oppgaver.find((x) => x.id === id);
      if (!o) dø(`Ukjent oppgave ${id}`);
      const m = maalOppgave(o);
      const r = endre((ko) => {
        const x = ko.oppgaver.find((y) => y.id === id);
        lagreMaaling(x, m);
        return x;
      });
      console.log(maalingLinje(r));
    }
  } else {
    const s = L.kostStatistikk(les(), { siden: sidenTid(verdi('--siden')) });
    if (!s.rader.length)
      console.log('Ingen ferdige oppgaver med målt kost ennå (måles ved sett <id> ferdig).');
    else {
      console.log(`Kost per oppgave (${s.total.n} ferdige, $${s.total.usd} totalt):`);
      for (const k of s.perKlasse)
        console.log(
          `  ${k.klasse.padEnd(2)} n=${String(k.n).padEnd(3)} median $${k.median_usd}  sum $${k.usd}` +
            (k.reviewet ? `  funn H=${k.H} M=${k.M} L=${k.L} (${k.reviewet} reviewet)` : ''),
        );
      const n = Number(verdi('--maks') ?? 10);
      console.log(`Siste ${Math.min(n, s.rader.length)}:`);
      for (const x of s.rader.slice(0, n))
        console.log(
          `  ${x.id.padEnd(12)} ${String(x.klasse).padEnd(2)} $${String(x.usd).padEnd(7)} ${x.agenter} agent(er)` +
            (x.funn ? `  H=${x.funn.H} M=${x.funn.M} L=${x.funn.L}` : '') +
            (x.resultat ? `  ${x.resultat}` : ''),
        );
    }
  }
} else if (kmd === 'prosjekter') {
  // ---- Prosjekt og funksjon ----
  const ko = les();
  if (!Object.keys(ko.prosjekter ?? {}).length)
    console.log(
      'Registeret er tomt: opprett med ko.mjs prosjekt <pid> --tittel "…" --prefiks EKS- (eller endre-mange --fil).\n',
    );
  for (const r of L.prosjektOversikt(ko)) {
    const deler = [
      `${r.ferdig}/${r.totalt} ferdig`,
      `${r.min_igjen} min igjen`,
      r.aktive ? `${r.aktive} aktive` : null,
      r.plukket ? `${r.plukket} plukket` : null,
      r.qa ? `${r.qa} i QA` : null,
      r.forslag ? `${r.forslag} forslag` : null,
      r.pause ? 'PAUSE' : null,
      r.prioritet_tillegg
        ? `prioritet ${r.prioritet_tillegg > 0 ? '+' : ''}${r.prioritet_tillegg}`
        : null,
      !r.i_register && r.pid !== L.UTEN_PROSJEKT ? 'ikke i registeret' : null,
    ].filter(Boolean);
    console.log(kutt(`${r.pid.padEnd(16)} ${deler.join(' · ')}`, BREDDE));
    const prefikser = ko.prosjekter?.[r.pid]?.prefikser ?? [];
    const omr = ko.prosjekter?.[r.pid]?.omrade;
    const info = [
      r.tittel,
      r.plan,
      prefikser.length ? `prefiks ${prefikser.join(' ')}` : null,
      omr ? `område ${omr}` : null,
      ko.prosjekter?.[r.pid]?.fase ? `fase ${ko.prosjekter[r.pid].fase}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    if (info) console.log(`  ${kutt(info, BREDDE - 2)}`);
    if (r.eiersporsmal.length) {
      const sp = r.eiersporsmal
        .slice(0, 3)
        .map((e) => `${e.sp} (${e.oppgaver})`)
        .join(', ');
      const flere = r.eiersporsmal.length > 3 ? ` +${r.eiersporsmal.length - 3} til` : '';
      console.log(`  ${kutt(`↳ venter på eieren: ${sp}${flere}`, BREDDE - 2)}`);
    }
  }
} else if (kmd === 'prosjekt') {
  const pid = a[1];
  if (!pid || pid.startsWith('--'))
    dø(
      'prosjekt <pid> [--tittel ..] [--plan ..] [--prefiks EKS- …] [--pause | --fortsett] [--prioritet N] [--omrade <oid|ingen>] [--filrot <sti …>] [--fase plan|ingen]',
    );
  if (a.includes('--pause') && a.includes('--fortsett')) dø('velg én av --pause og --fortsett');
  const felt = {};
  if (verdi('--tittel') != null) felt.tittel = verdi('--tittel');
  if (verdi('--plan') != null) felt.plan = verdi('--plan');
  if (a.includes('--prefiks')) felt.prefikser = verdier('--prefiks');
  if (a.includes('--pause')) felt.pause = true;
  if (a.includes('--fortsett')) felt.pause = null;
  // Området prosjektet hører til («ingen» tar det ut).
  if (verdi('--omrade') != null)
    felt.omrade = verdi('--omrade') === 'ingen' ? null : verdi('--omrade');
  if (verdi('--prioritet') != null) {
    const n = Number(String(verdi('--prioritet')).replace(',', '.'));
    if (!Number.isFinite(n))
      dø('--prioritet må være et tall (tillegg til prioriteten, f.eks. 20 eller -10)');
    felt.prioritet_tillegg = n === 0 ? null : n;
  }
  // Filrøtter (signal for klassifiser); --filrot uten verdier fjerner lista.
  if (a.includes('--filrot')) {
    const r = verdier('--filrot');
    felt.filrot = r.length ? r : null;
  }
  // Fase plan = prosjektet finnes i planarbeidet, men har ingen køoppgaver ennå («ingen» tar det bort).
  if (verdi('--fase') != null) felt.fase = verdi('--fase') === 'ingen' ? null : verdi('--fase');
  const r = endreLogget('prosjekt', (ko) => {
    const ny = !Object.hasOwn(ko.prosjekter ?? {}, pid);
    const reg = L.nyttRegister(ko.prosjekter, { [pid]: felt }, ko.omrader);
    if (reg.feil.length) dø(`Ingenting endret:\n  ${reg.feil.join('\n  ')}`);
    if (felt.fase === 'plan') {
      const har = ko.oppgaver.filter(
        (o) => o.status !== 'kansellert' && L.prosjektFor(o, reg.register) === pid,
      ).length;
      if (har)
        dø(
          `Ingenting endret: ${pid} har ${har} køoppgave(r); fase plan gjelder bare prosjekter uten køoppgaver.`,
        );
    }
    ko.prosjekter = reg.register;
    // Prefikser på ett tegn og overlappende prefikser (lengste prefiks vinner, prosjektFor). Meld fra, ikke nekt.
    const advarsler = L.prefiksAdvarsler(ko.prosjekter, { pid });
    const antall = ko.oppgaver.filter((o) => L.prosjektFor(o, ko.prosjekter) === pid).length;
    return { ny, p: ko.prosjekter[pid], antall, advarsler };
  });
  console.log(
    `${r.ny ? 'Opprettet' : 'Endret'} prosjekt ${pid} (${r.antall} oppgaver): ${JSON.stringify(r.p)}`,
  );
  for (const x of r.advarsler) console.log(`ADVARSEL: ${x}`);
  if (angreHint()) console.log(angreHint());
} else if (kmd === 'endre-mange') {
  const fil = verdi('--fil');
  if (!fil) dø('endre-mange --fil <json>');
  const inn = JSON.parse(fs.readFileSync(fil, 'utf8'));
  const json = a.includes('--json');
  const naa = new Date().toISOString();
  // Med --json: feilene som JSON på stdout (tavla viser dem); låsen slippes som i dø().
  const feilUt = (s, kode = 1) => {
    if (!json) dø(`Ingenting endret (${s.length} feil):\n  ${s.join('\n  ')}`, kode);
    console.log(JSON.stringify({ ok: false, feil: s }));
    if (harLas) fs.rmSync(LAS, { recursive: true, force: true });
    process.exit(kode);
  };
  // `plan` må peke til en planpost som finnes (null tar koblingen bort).
  const planFeilListe = (reg) =>
    (Array.isArray(inn) ? inn : (inn?.oppgaver ?? []))
      .filter((e) => e && typeof e === 'object' && e.plan != null)
      .map((e) => {
        const fe = P.planKoblingFeil(reg, e.plan);
        return fe ? `${e.id ?? '?'}: ${fe}` : null;
      })
      .filter(Boolean);
  if (a.includes('--torr')) {
    // Forhåndsvisning. Regner ut alt på en kopi og skriver ingenting; `endret` er versjonen tavla sender
    // tilbake som --forvent-endret når eieren bekrefter.
    const ko = les();
    sjekkForvent(ko);
    const s = L.endreMange(ko, inn, { av: avNavn(), naa, torr: true });
    if (s.feil.length) feilUt(s.feil);
    const pf = planFeilListe(lesPlaner());
    if (pf.length) feilUt(pf);
    if (json)
      console.log(
        JSON.stringify({
          ok: true,
          torr: true,
          endret: ko.endret ?? null,
          endringer: s.endringer,
          advarsler: s.advarsler,
        }),
      );
    else {
      const ider = new Set(s.endringer.filter((e) => e.id).map((e) => e.id));
      console.log(
        `Tørrkjøring (ingenting skrevet): ${s.endringer.length} felt i ${ider.size} oppgave(r)` +
          `${s.prosjekter.length ? ` og ${s.prosjekter.length} prosjekt(er)` : ''}; ` +
          `${s.endret.length - ider.size} av ${s.endret.length} oppgave(r) er allerede slik. Køens versjon: ${ko.endret ?? '(ingen)'}`,
      );
      for (const l of L.diffLinjer(s.endringer)) console.log(`  ${l}`);
      for (const x of s.advarsler) console.log(`ADVARSEL: ${x}`);
    }
  } else {
    // Alt eller ingenting: endreMange validerer alt før noe endres, og dø()/feilUt slipper låsen uten å skrive fila.
    const r = endreLogget('endre-mange', (ko) => {
      const pf = planFeilListe(lesPlaner());
      if (pf.length) feilUt(pf);
      const s = L.endreMange(ko, inn, { av: avNavn(), naa });
      if (s.feil.length) feilUt(s.feil);
      // Nye eller endrede prefikser: samme advarsler som ko.mjs prosjekt (ett tegn, overlapp).
      const pre = s.prosjekter
        .filter((p) => inn?.prosjekter?.[p]?.prefikser)
        .flatMap((pid) => L.prefiksAdvarsler(ko.prosjekter, { pid }));
      return { ...s, advarsler: [...s.advarsler, ...new Set(pre)] };
    });
    if (json)
      console.log(
        JSON.stringify({
          ok: true,
          endret: r.endret,
          endringer: r.endringer,
          advarsler: r.advarsler,
          logg: sistePost?.nr ?? null,
        }),
      );
    else {
      console.log(
        `Endret ${r.endret.length} oppgave(r)${r.prosjekter.length ? ` og ${r.prosjekter.length} prosjekt(er) i registeret (${r.prosjekter.join(', ')})` : ''}.`,
      );
      for (const x of r.advarsler) console.log(`ADVARSEL: ${x}`);
      if (angreHint()) console.log(angreHint());
    }
  }
} else if (kmd === 'plukkbare') {
  // ---- Plukking ----
  const ko = les();
  const maks = verdi('--maks-min');
  if (maks != null && !(Number(maks) > 0)) dø('--maks-min må være et tall > 0');
  const liste = L.plukkbare(ko, {
    etikett: verdi('--etikett'),
    prosjekt: verdi('--prosjekt'),
    maksMin: maks == null ? undefined : Number(maks),
    ucommittet: ucommittetStier(),
  });
  if (!liste.length) console.log('Ingenting kan plukkes nå med dette filteret (se `vis`).');
  for (const p of liste) {
    const merker = [
      ...p.etiketter,
      ...(p.migr ? ['migr'] : []),
      ...(p.pauset ? ['prosjekt pauset'] : []),
      ...(p.ucommittet ? [`ucommittet i hovedtreet: ${p.ucommittet}`] : []),
      // Trinnet når fokus gjelder (utenfor fokus står sist og kan fortsatt plukkes).
      ...('steg' in p ? [p.utenfor_fokus ? 'utenfor fokus' : L.stegTekst(p)] : []),
    ];
    const hode =
      `${p.id.padEnd(12)} ${p.klasse.padEnd(2)} ${`${p.anslag} min`.padEnd(7)} prio ${String(p.score).padEnd(7)} ` +
      `${p.prosjekt}${p.funksjon ? ` / ${p.funksjon}` : ''}${merker.length ? ` [${merker.join(', ')}]` : ''}`;
    console.log(kutt(hode, BREDDE));
    console.log(`  ${kutt(p.tittel, BREDDE - 2)}`);
  }
  if (liste.length)
    console.log(`\n${liste.length} kan plukkes. Plukk: ko.mjs plukk <id> --av "<hvem>"`);
} else if (kmd === 'plukk') {
  const id = a[1];
  if (!id || id.startsWith('--')) dø('plukk <id> --av "<hvem>" [--tving]');
  const r = endre((ko) => {
    const s = L.plukk(ko, id, { av: verdi('--av'), tving: a.includes('--tving') });
    if (s.feil) dø(s.feil);
    return s;
  });
  const o = r.oppgave;
  const g = grenInfo(o.gren);
  const fil = oppdragFil(o);
  const wt = `.claude/worktrees/ko-${id}`;
  console.log(
    `Plukket ${id} (av ${o.plukket_av}): gren ${o.gren}, migrasjonsblokk ${o.migr_blokk ?? 'ingen'}, klasse ${o.klasse}, anslag ${L.anslag(o)} min.`,
  );
  if (r.overstyrt.length) console.log(`--tving overstyrte: ${r.overstyrt.join(' · ')}`);
  // Eierfilene endret utenfor køen siden oppgaven ble lagt inn, eller commits som nevner id-en.
  skrivEksternVarsel(o);
  console.log(`Oppdrag: ${fil ?? `teksten står i køen (ko.mjs sporfil ${id} --ut <fil>)`}`);
  console.log(
    [
      'Neste steg (samme protokoll som et køspor: eget worktree, felles protokoll, gater og review etter klasse):',
      g.finnes
        ? `  1. Worktree på grenen som finnes (${g.commits} commit(s) foran ${BASE}): git worktree add ${wt} ${o.gren}`
        : `  1. Worktree: git worktree add ${wt} -b ${o.gren} ${BASE}`,
      `  2. Oppdraget: ko.mjs sporfil ${id} --ut <scratch>/ko-spor.md; lag-ko-felles.mjs --ut <scratch>/ko-felles.md;`,
      `     lag-oppdrag.mjs --felles <scratch>/ko-felles.md --spor <scratch>/ko-spor.md --head <HEAD>`,
      `  3. I worktreet: node <hovedtre>/scripts/orkestrator/klargjor-spor.mjs ${id} --gren ${o.gren} --scratchpad "<scratch>"`,
      `  4. Ferdig: orkestrator aktiv → ko.mjs lever ${id} (den fletter). Ingen orkestrator → flett selv`,
      `     (flett-spor.mjs ${o.gren})${MIGR.mappe ? ', push migrasjonene' : ''}, så ko.mjs sett ${id} ferdig.`,
      '     Aldri git push uten eierens «push».',
      `  Gir du opp: ko.mjs slipp ${id} (grenen og migrasjonsblokken beholdes).`,
    ].join('\n'),
  );
} else if (kmd === 'lever') {
  const id = a[1];
  if (!id) dø('lever <id>');
  const r = endre((ko) => {
    const s = L.lever(ko, id);
    if (s.feil) dø(s.feil);
    return s;
  });
  console.log(
    `${id}: review (levert av ${r.oppgave.plukket_av ?? '?'}). Orkestratoren fletter ${r.oppgave.gren ?? grenFor(id)}.`,
  );
} else if (kmd === 'slipp') {
  const id = a[1];
  if (!id) dø('slipp <id>');
  // Commitene telles før låsen (git skal ikke kjøre med køfila låst). Grenen står i oppgaven (ko/<id>).
  const før = les().oppgaver.find((x) => x.id === id);
  const g = grenInfo(før?.gren ?? grenFor(id));
  const r = endre((ko) => {
    const s = L.slipp(ko, id, { commits: g.commits });
    if (s.feil) dø(s.feil);
    return s;
  });
  console.log(`${id}: sluppet (var plukket av ${r.av ?? '?'}), venter igjen.`);
  if (r.advarsel) console.log(`ADVARSEL: ${r.advarsel}`);
} else if (kmd === 'qa') {
  // ---- Visuell QA: bare eieren setter qa ok / qa avvik ----
  const under = a[1];
  if (!under) {
    const ko = les();
    const grupper = L.qaListe(ko);
    const antall = grupper.reduce(
      (n, p) => n + p.funksjoner.reduce((m, f) => m + f.oppgaver.length, 0),
      0,
    );
    if (!antall) console.log('QA-lista er tom.');
    else console.log(`QA-lista: ${antall} ferdig(e) oppgave(r) venter på at eieren ser på dem.\n`);
    for (const p of grupper) {
      console.log(kutt(`${p.pid}${p.tittel ? `  ${p.tittel}` : ''}`, BREDDE));
      for (const f of p.funksjoner) {
        console.log(`  ${kutt(f.funksjon, BREDDE - 2)}`);
        for (const o of f.oppgaver) {
          const alder = o.ferdig
            ? `ferdig for ${L.alderTekst(Date.now() - Date.parse(o.ferdig))} siden`
            : '';
          console.log(`    ${o.id.padEnd(12)} ${alder}`);
          console.log(`      ${kutt(`se etter: ${o.tittel}`, BREDDE - 6)}`);
        }
      }
    }
    if (antall)
      console.log(
        '\nGodkjenn: ko.mjs qa ok <id…> · avvik: ko.mjs qa avvik <id> "<hva er galt, og hvor>"',
      );
  } else if (under === 'ok') {
    const ider = posisjonelle(2);
    if (!ider.length) dø('qa ok <id> [...]');
    const r = endre((ko) => {
      const s = L.qaOk(ko, ider);
      // Alt eller ingenting, som godkjenn.
      if (s.feil.length) dø(`Ingenting endret:\n  ${s.feil.join('\n  ')}`);
      return s;
    });
    console.log(`QA ok: ${r.ok.join(', ')}`);
  } else if (under === 'avvik') {
    const [id, tekst] = posisjonelle(2);
    if (!id || !tekst) dø('qa avvik <id> "<hva er galt, og hvor>"');
    const r = endre((ko) => {
      const s = L.qaAvvik(ko, id, tekst);
      if (s.feil) dø(s.feil);
      return s;
    });
    console.log(
      `${id}: QA-avvik. Rettingsoppgaven ${r.retting.id} er lagt i køen (${r.retting.status}, klasse K, ${r.retting.prosjekt ?? L.UTEN_PROSJEKT}${r.retting.funksjon ? ` / ${r.retting.funksjon}` : ''}).`,
    );
  } else {
    dø('qa [ok <id…> | avvik <id> "<tekst>"]');
  }
} else if (kmd === 'ekstern') {
  // ---- Arbeid utenfor køen ----
  const under = a[1] && !a[1].startsWith('--') ? a[1] : null;
  if (!under) eksternSkann();
  else if (under === 'add') {
    const navn = verdi('--navn');
    const r = endre((ko) => {
      const s = L.eksternAdd(ko, {
        navn,
        filer: verdier('--filer'),
        db: verdier('--db'),
        gren: verdi('--gren') ?? null,
      });
      if (s.feil) dø(s.feil);
      return s;
    });
    const eier = [...r.rad.eier_filer, ...r.rad.eier_db].join(', ');
    console.log(
      `${r.ny ? 'Registrert' : 'Oppdatert'} ${r.rad.id} («${r.rad.ekstern_navn}»${r.rad.gren ? `, gren ${r.rad.gren}` : ''}): ` +
        `eier ${eier}. Køen starter ingenting som kolliderer før: ko.mjs ekstern ferdig "${r.rad.ekstern_navn}"`,
    );
    for (const x of r.advarsler) console.log(`ADVARSEL: ${x}`);
  } else if (under === 'ferdig') {
    const [navn] = posisjonelle(2);
    const r = endre((ko) => {
      const s = L.eksternFerdig(ko, navn);
      if (s.feil) dø(s.feil);
      return s;
    });
    console.log(
      `${r.rad.id} («${r.rad.ekstern_navn}»): ferdig. Filene er fri for køen igjen. Er arbeidet committet på ${BASE}, ` +
        'viser ko.mjs ekstern om det nevner ventende oppgaver.',
    );
  } else if (under === 'godta') {
    const [id, ref] = posisjonelle(2);
    if (!id || !ref) dø('ekstern godta <id> <sha>');
    const full = String(gitLes(['rev-parse', '-q', '--verify', `${ref}^{commit}`]) ?? '').trim();
    if (!full) dø(`Fant ikke commit ${ref}.`);
    // Bare det som er på basegrenen, kan regnes som gjort (en gren utenfor køen er ikke levert ennå).
    if (gitLes(['merge-base', '--is-ancestor', full, BASE]) == null)
      dø(`${ref} er ikke på ${BASE} (flett den først, eller vent).`);
    const melding = gitLes(['log', '-1', '--format=%B', full]) ?? '';
    const nevnt = L.nevnteIder(melding, [id]).length > 0;
    const r = endre((ko) => {
      const s = L.eksternGodta(ko, id, full, { nevnt });
      if (s.feil) dø(s.feil);
      return s;
    });
    console.log(
      `${id}: ferdig (gjort utenfor køen i ${full.slice(0, 8)})` +
        `${r.qa ? ' · etiketten visuell: står nå i eierens QA-liste (ko.mjs qa)' : ''}` +
        `${nevnt ? '' : ' · NB: commit-meldingen nevner ikke id-en (står i merknaden)'}`,
    );
  } else {
    dø(
      'ekstern [--siden …] [--alle] | ekstern godta <id> <sha> | ekstern add --navn "<økt>" --filer <…> [--gren <g>] | ' +
        'ekstern ferdig "<navn>"',
    );
  }
} else if (kmd === 'orkestrator') {
  // ---- Orkestrator-markøren ----
  const [under] = posisjonelle(1, ['--okt', '--hendelse']);
  if (under === 'puls') {
    const m = pulsMarkor(verdi('--hendelse') ?? 'puls');
    if (!m) dø(`Kunne ikke skrive ${MARKOR}.`);
    console.log(
      `Orkestrator-markør: «${m.okt}», oppdatert ${m.oppdatert} (utløper etter 2 t uten ny puls).`,
    );
    const av = L.avviklingVakt(m);
    if (av.stopp)
      console.log(
        `${av.melding}\n(Vanlig vei er komprimering, som opphever avviklingen. Er dette likevel en NY økt ` +
          `(nødrotasjon), kjør puls med et annet --okt-navn enn «${m.okt}».)`,
      );
    // Pulsen går hver løkkerunde, så lav parallellitet sjekkes av og til også uten fyll og motta.
    parallellVarsel();
  } else if (under === 'stopp') {
    fs.rmSync(MARKOR, { force: true });
    console.log('Orkestrator-markøren er fjernet: ingen orkestrator er aktiv.');
  } else if (!under) {
    const s = L.orkestratorStatus(lesMarkor());
    if (a.includes('--json')) console.log(JSON.stringify(s, null, 2));
    else if (s.aktiv)
      console.log(
        `AKTIV ORKESTRATOR: «${s.okt}», sist oppdatert for ${L.alderTekst(s.alder_ms)} siden (${s.hendelse ?? '-'}). ` +
          'Den som har plukket en oppgave, leverer: ko.mjs lever <id>.' +
          (L.avviklingVakt(lesMarkor()).stopp
            ? ' Økta er i AVVIKLING (ingen nye starter til den er komprimert).'
            : ''),
      );
    else
      console.log(
        `INGEN AKTIV ORKESTRATOR (${s.grunn}${s.okt ? `; sist «${s.okt}» for ${L.alderTekst(s.alder_ms)} siden` : ''}). ` +
          'Den som har plukket en oppgave, fletter selv (skillen plukk).',
      );
  } else {
    dø('orkestrator [puls [--okt "<navn>"] | stopp]');
  }
} else if (kmd === 'sky-pakke') {
  // ---- Sky: pakka til rutinen «ko-sky» eller til å lime inn i en skyøkt ----
  // Én id, eller en bunt på høyst 4 (sum anslag ≤ ca. 120 min) som gjøres etter hverandre i samme skyøkt.
  const ider = posisjonelle(1, ['--ut']);
  if (!ider.length) dø('sky-pakke <id> [<id> …] [--ut <fil>] [--tving]');
  const ko = les();
  const kontekst = skyKontekst();
  const deler = ider.map((id) => {
    const o = ko.oppgaver.find((x) => x.id === id);
    if (!o) dø(`Ukjent oppgave ${id}`);
    return { o, ...skyVurder(ko, o, kontekst) };
  });
  const grunner = [
    ...deler.flatMap((d) => d.egnethet.grunner.map((g) => `${d.o.id}: ${g}`)),
    ...L.skyBuntTak(deler.map((d) => d.o)).map((g) => `bunten: ${g}`),
  ];
  if (grunner.length) {
    const tekst = grunner.join('\n  ');
    if (!a.includes('--tving'))
      dø(`Ikke egnet for sky:\n  ${tekst}\n(--tving lager pakken likevel)`);
    // Til stderr, så pakka på stdout er ren (tavla kopierer den).
    console.error(`ADVARSEL: ikke egnet for sky (--tving):\n  ${tekst}`);
  }
  const pakke = L.skyBuntPakke(deler, ko);
  const ut = verdi('--ut');
  if (ut) {
    fs.writeFileSync(ut, `${pakke}\n`);
    console.log(
      `Skrev skypakka for ${ider.join(', ')} til ${ut} (${pakke.length} tegn). Start: RemoteTrigger run med ` +
        `{ "text": <pakka> }, så ko.mjs sky start ${ider.join(' ')} --kjoring <økt-id>.`,
    );
  } else process.stdout.write(`${pakke}\n`);
} else if (kmd === 'sky-bunter') {
  // Forslag til bunter av skyegnede oppgaver (samme prosjekt/funksjon etter hverandre), etter prioritet.
  const maks = Number(verdi('--maks') ?? L.SKY_BUNT_MAKS);
  const maksMin = Number(verdi('--maks-min') ?? L.SKY_BUNT_MIN);
  if (!(maks >= 1) || !(maksMin > 0)) dø('--maks og --maks-min må være tall over 0');
  const ko = les();
  const kontekst = skyKontekst();
  const register = ko.prosjekter ?? {};
  const kandidater = ko.oppgaver
    .filter((o) => o.status === 'venter' && skyVurder(ko, o, kontekst).egnethet.egnet)
    .map((o) => ({
      id: o.id,
      prosjekt: L.prosjektFor(o, register),
      funksjon: o.funksjon ?? null,
      anslag: L.anslag(o),
      score: L.score(o, ko.oppgaver, Date.now(), register),
    }));
  const bunter = L.skyBunter(kandidater, { maks, maksMin });
  // --json: maskinlesbart for køtavla (visningen «Sky»), med ferdig kommando for sky-start.mjs per bunt.
  if (a.includes('--json')) {
    const tittelJ = new Map(ko.oppgaver.map((o) => [o.id, o.tittel ?? '']));
    console.log(
      JSON.stringify({
        bunter: bunter.map((b) => ({
          ider: b.ider,
          minutter: b.minutter,
          omrader: b.omrader,
          titler: Object.fromEntries(b.ider.map((id) => [id, tittelJ.get(id)])),
          kommando: `node scripts/orkestrator/sky-start.mjs ${b.ider.join(' ')}`,
        })),
        okter: L.skyOkter(ko),
        maks: L.SKY_MAKS,
        pushet: Boolean(kontekst.pushetHead),
      }),
    );
    process.exit(0);
  }
  if (!bunter.length)
    console.log(
      `Ingen skyegnede oppgaver nå${kontekst.pushetHead ? '' : ` (fant ikke ${REMOTE}/${BASE})`}.`,
    );
  const tittel = new Map(ko.oppgaver.map((o) => [o.id, o.tittel ?? '']));
  bunter.forEach((b, i) => {
    console.log(
      `Bunt ${i + 1}: ${b.ider.length} oppgave(r), ${b.minutter} min · ${b.omrader.join(' + ')}`,
    );
    for (const id of b.ider) console.log(kutt(`  ${id.padEnd(12)} ${tittel.get(id)}`, BREDDE));
    console.log(`  → ko.mjs sky-pakke ${b.ider.join(' ')} --ut <fil>`);
  });
  const okter = L.skyOkter(ko);
  if (bunter.length) console.log(`\n${okter} skyøkt(er) går nå (høyst ${L.SKY_MAKS}).`);
} else if (kmd === 'sky') {
  const [under, id, ...flere] = posisjonelle(1, ['--kjoring', '--sha', '--gren']);
  const tving = a.includes('--tving');
  if (!under) {
    // Oversikt: skyøktene som går, og de ventende som er egnet.
    const ko = les();
    const iSky = ko.oppgaver.filter(L.erSky);
    console.log(`Skyøkter (${iSky.length} av høyst ${L.SKY_MAKS}):`);
    if (!iSky.length) console.log('  ingen');
    for (const o of iSky)
      console.log(
        kutt(
          `  ${o.id.padEnd(12)} startet for ${L.alderTekst(Date.now() - Date.parse(o.sky.startet))} siden` +
            `${o.sky.kjoring ? ` · ${o.sky.kjoring}` : ''}  ${o.tittel ?? ''}`,
          BREDDE,
        ),
      );
    const k = skyKontekst();
    const egnede = ko.oppgaver
      .filter((o) => o.status === 'venter')
      .filter((o) => skyVurder(ko, o, k).egnethet.egnet)
      .map((o) => ({ o, score: L.score(o, ko.oppgaver, Date.now(), ko.prosjekter ?? {}) }))
      .sort((x, y) => y.score - x.score || x.o.id.localeCompare(y.o.id));
    console.log(
      `\nEgnet for sky nå: ${egnede.length}${k.pushetHead ? '' : ` (fant ikke ${REMOTE}/${BASE})`}`,
    );
    for (const { o } of egnede.slice(0, 15))
      console.log(
        kutt(
          `  ${o.id.padEnd(12)} ${o.klasse.padEnd(2)} ${`${L.anslag(o)} min`.padEnd(7)} ${o.tittel ?? ''}`,
          BREDDE,
        ),
      );
    if (egnede.length > 15) console.log(`  … og ${egnede.length - 15} til`);
    if (egnede.length) console.log('\nPakke: ko.mjs sky-pakke <id> [--ut <fil>]');
  } else if (under === 'start') {
    // Flere id-er = en bunt i samme skyøkt (samme --kjoring).
    const ider = id ? [id, ...flere] : [];
    if (!ider.length) dø('sky start <id> [<id> …] [--kjoring <økt-id|url>] [--tving]');
    const kjoring = verdi('--kjoring') ?? null;
    if (kjoring != null && (!kjoring.trim() || kjoring.length > 300 || /\s/.test(kjoring)))
      dø('--kjoring må være økt-id-en eller lenken (uten mellomrom, høyst 300 tegn)');
    // Egnetheten trenger git (remotens basegren og lokale endringer), så den regnes før låsen.
    const ko0 = les();
    const kontekst = skyKontekst();
    const egnethet = {};
    for (const x of ider) {
      const o0 = ko0.oppgaver.find((y) => y.id === x);
      if (!o0) dø(`Ukjent oppgave ${x}`);
      if (!L.erSky(o0)) egnethet[x] = skyVurder(ko0, o0, kontekst).egnethet;
    }
    const r = endre((ko) => {
      const s = L.skyStart(ko, ider, { egnethet, kjoring, tving });
      if (s.feil) dø(s.feil);
      return s;
    });
    for (const x of r.nye) loggTid(x, 'sky-start', kjoring ? `kjøring ${kjoring}` : 'uten kjøring');
    if (r.nye.length)
      console.log(
        `Startet i sky: ${r.nye.join(', ')}${kjoring ? ` (${kjoring})` : ''}. Skyen lager ${grenFor('<id>')} fra ${REMOTE}/${BASE}.`,
      );
    if (r.igjen.length)
      console.log(
        `Sto allerede i sky: ${r.igjen.join(', ')}${kjoring ? `; kjøringen er satt til ${kjoring}` : ''}.`,
      );
    if (r.overstyrt.length) console.log(`--tving overstyrte: ${r.overstyrt.join(' · ')}`);
    console.log(
      'Når SKY-FERDIG <id> kommer: ko.mjs sky ferdig <id> [--gren <grenen skyen pushet>] [--sha <sha>]. ' +
        'Gir den opp (SKY-STOPP): ko.mjs sky avbryt <id>.',
    );
  } else if (under === 'ferdig') {
    if (!id) dø('sky ferdig <id> [--gren <gren>] [--sha <sha>]');
    const o0 = les().oppgaver.find((x) => x.id === id);
    if (!o0) dø(`Ukjent oppgave ${id}`);
    if (!L.erSky(o0)) dø(`${id} står ikke i en skyøkt (status ${o0.status}).`);
    const gren = verdi('--gren') ?? grenFor(id);
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/.test(gren) || gren.includes('..'))
      dø(`Ugyldig grennavn: ${gren}`);
    const sha = verdi('--sha') ?? null;
    if (sha != null && !/^[0-9a-f]{7,40}$/i.test(sha)) dø(`Ugyldig sha: ${sha}`);
    // Hent grenen skyen pushet (og basegrenen, så tellingen er mot det som er pushet nå).
    const hentet = git([
      'fetch',
      '-q',
      REMOTE,
      `+refs/heads/${gren}:refs/remotes/${REMOTE}/${gren}`,
      `+refs/heads/${BASE}:refs/remotes/${REMOTE}/${BASE}`,
    ]);
    if (hentet == null)
      dø(
        `Fant ikke ${gren} på ${REMOTE} (git fetch feilet). Pushet skyen til en annen gren? Bruk --gren <navn>.`,
      );
    const fjern = `refs/remotes/${REMOTE}/${gren}`;
    const antall =
      Number(git(['rev-list', '--count', `refs/remotes/${REMOTE}/${BASE}..${fjern}`]) ?? 0) || 0;
    if (antall < 1)
      dø(`${REMOTE}/${gren} har ingen commits over ${REMOTE}/${BASE}; ingenting å flette.`);
    const tips = git(['rev-parse', fjern]);
    if (sha && git(['merge-base', '--is-ancestor', sha, fjern]) == null)
      dø(`${sha} finnes ikke på ${REMOTE}/${gren} (tips ${tips?.slice(0, 10)}).`);
    // Lokal køgren på skyens commits, så flett-spor og «Merge branch '<køgren>'» (ekstern-skannet) virker som
    // for et lokalt spor. Har en lokal køgren commits som ikke er med, stopper vi i stedet for å overskrive dem.
    const lokal = grenFor(id);
    if (gren !== lokal) {
      const finnes = git(['rev-parse', '-q', '--verify', `refs/heads/${lokal}`]) != null;
      if (finnes && git(['merge-base', '--is-ancestor', `refs/heads/${lokal}`, fjern]) == null)
        dø(
          `Lokal ${lokal} har commits som ikke er på ${REMOTE}/${gren}; flett for hånd (flett-spor.mjs ${REMOTE}/${gren}).`,
        );
      if (git(['branch', '-f', lokal, fjern]) == null)
        dø(`Kunne ikke sette ${lokal} til ${REMOTE}/${gren} (står den i et worktree?).`);
    } else if (git(['rev-parse', '-q', '--verify', `refs/heads/${lokal}`]) == null) {
      git(['branch', lokal, fjern]);
    } else if (git(['merge-base', '--is-ancestor', `refs/heads/${lokal}`, fjern]) != null) {
      git(['branch', '-f', lokal, fjern]);
    } else {
      dø(`Lokal ${lokal} har commits som ikke er på ${REMOTE}/${gren}; flett for hånd.`);
    }
    const r = endre((ko) => {
      const s = L.skyFerdig(ko, id, { gren, sha: sha ?? tips });
      if (s.feil) dø(s.feil);
      return s;
    });
    loggTid(
      id,
      'sky-ferdig',
      `${antall} commit(s) på ${gren}, ${minutter(r.oppgave.sky.startet, r.oppgave.sky.ferdig)} min i sky`,
    );
    console.log(
      [
        `${id}: fullført i sky, review. ${antall} commit(s) på ${REMOTE}/${gren} (tips ${String(tips).slice(0, 10)}).`,
        'Orkestratoren fletter:',
        `  1. node scripts/orkestrator/flett-spor.mjs ${lokal}   (lokal gren = ${REMOTE}/${gren})`,
        `  2. git push ${REMOTE} --delete ${gren}   (etter flettingen; en fast claude/…-gren ville ellers blitt gjenbrukt)`,
        `  3. ko.mjs sett ${id} ferdig`,
      ].join('\n'),
    );
  } else if (under === 'avbryt') {
    if (!id) dø('sky avbryt <id>');
    const før = les().oppgaver.find((x) => x.id === id);
    const g = grenInfo(før?.gren ?? grenFor(id));
    const r = endre((ko) => {
      const s = L.skyAvbryt(ko, id, { commits: g.commits });
      if (s.feil) dø(s.feil);
      return s;
    });
    loggTid(id, 'sky-avbrutt', '');
    console.log(`${id}: skyøkta er avbrutt, oppgaven venter igjen.`);
    if (r.advarsel) console.log(`ADVARSEL: ${r.advarsel}`);
  } else {
    dø('sky [start <id> [--kjoring …] | ferdig <id> [--gren …] [--sha …] | avbryt <id>]');
  }
} else if (kmd === 'samle') {
  // Samlekøen. Uten argumenter: gruppene med sum mot målet. `pakk`: ett nytt spor av oppgitte id-er, eller
  // forslag for de klare gruppene (--auto), utført bare med --utfor.
  if (a[1] !== 'pakk') {
    if (a[1]) dø('samle [pakk <id> <id> … --id <ny-id> [--tittel "…"] | pakk --auto [--utfor]]');
    const ko = les();
    const gr = L.samleGrupper(ko);
    if (!gr.length) {
      console.log('Samlekøen er tom (legg inn små, ikke-blokkerende oppgaver med "samles": true).');
    } else {
      const n = gr.reduce((s, g) => s + g.antall, 0);
      const min = gr.reduce((s, g) => s + g.sum, 0);
      console.log(
        `SAMLEKØEN: ${n} oppgave(r), ${min} innholdsminutter i ${gr.length} gruppe(r). Mål per klasse: ` +
          Object.entries(L.SAMLE_MAAL)
            .map(([k, m]) => `${k} ${m.min}–${m.maks} min`)
            .join(', ') +
          '. Klar til pakking fra nedre mål.',
      );
      let forrigePid = null;
      for (const g of gr) {
        if (g.pid !== forrigePid) {
          console.log(kutt(`\n${g.pid}${g.tittel ? `  ${g.tittel}` : ''}`, BREDDE));
          forrigePid = g.pid;
        }
        console.log(kutt(`  ${samleGruppeLinje(g)}`, BREDDE));
        for (const f of g.funksjoner) {
          console.log(kutt(`    ${f.funksjon} (${f.sum} min)`, BREDDE));
          for (const id of f.ider) {
            const o = g.oppgaver.find((x) => x.id === id);
            const kol = `      ${o.id.padEnd(14)} ${`${o.innhold_min} min`.padEnd(8)} ${o.status === 'forslag' ? 'forslag ' : ''}`;
            console.log(kol + kutt(o.tittel, BREDDE - kol.length));
          }
        }
        if (g.felles_filer.length)
          console.log(kutt(`    felles filer: ${g.felles_filer.join(', ')}`, BREDDE));
      }
      if (gr.some((g) => g.klar))
        console.log('\nForslag til pakker: ko.mjs samle pakk --auto (utføres med --utfor).');
    }
  } else if (a.includes('--auto')) {
    const utfor = a.includes('--utfor');
    const forslag = L.samleForslag(les());
    if (!forslag.length) {
      console.log('Ingen grupper i samlekøen er klare til pakking.');
    } else if (!utfor) {
      console.log(`Forslag (${forslag.length}; utfør alle med ko.mjs samle pakk --auto --utfor):`);
      for (const f of forslag)
        console.log(
          f.ut
            ? `  ${f.pid} ${f.klasse}: ${f.deler[0]} har ${f.sum} min alene; ta den ut: ` +
                `ko.mjs endre ${f.deler[0]} --json '{"samles":false}'`
            : `  ${f.pid} ${f.klasse}, ${f.sum} min: ko.mjs samle pakk ${f.deler.join(' ')} --id ${f.id}`,
        );
    } else {
      // Alle forslagene i én skriving under låsen: alt eller ingenting (forslagene regnes på nytt inne i låsen).
      const r = samlePakkUtfor((ko) => L.samleForslag(ko).map((f) => ({ ...f, tittel: null })));
      for (const p of r) console.log(samleUtfortLinje(p));
    }
  } else {
    const ider = posisjonelle(2, ['--id', '--tittel', '--forvent-endret', '--av']);
    const nyId = verdi('--id');
    if (!ider.length || !nyId) dø('samle pakk <id> <id> … --id <ny-id> [--tittel "…"]');
    const r = samlePakkUtfor(() => [
      { id: nyId, deler: ider, tittel: verdi('--tittel') ?? null, ut: false },
    ]);
    for (const p of r) console.log(samleUtfortLinje(p));
  }
} else if (kmd === 'omrade') {
  // ---- Områder, fokus og parkering ----
  const oid = a[1];
  if (!oid || oid.startsWith('--'))
    dø(
      'omrade <oid> [--tittel "…"] [--beskrivelse "…"] [--prosjekter <pid> …] [--fjern <pid> …] | omrade <oid> --slett',
    );
  const felt = {};
  if (verdi('--tittel') != null) felt.tittel = verdi('--tittel');
  if (a.includes('--beskrivelse')) felt.beskrivelse = verdi('--beskrivelse') || null;
  if (a.includes('--prosjekter')) felt.prosjekter = verdier('--prosjekter');
  if (a.includes('--fjern')) felt.fjern = verdier('--fjern');
  if (a.includes('--slett')) felt.slett = true;
  const r = endre((ko) => {
    // Tavla sender --forvent-endret (køens versjon fra forhåndsvisningen); exit 6 når køen er endret siden.
    sjekkForvent(ko);
    const s = L.settOmrade(ko, oid, felt);
    if (s.feil.length) dø(`Ingenting endret:\n  ${s.feil.join('\n  ')}`);
    return s;
  });
  if (r.slettet) console.log(`Slettet område ${oid}.`);
  else
    console.log(
      `${r.ny ? 'Opprettet' : 'Endret'} område ${oid}: ${JSON.stringify(r.omrade)}` +
        `${r.flyttet.length ? `; prosjekter inn: ${r.flyttet.join(', ')}` : ''}` +
        `${r.fjernet.length ? `; tatt ut: ${r.fjernet.join(', ')}` : ''}`,
    );
} else if (kmd === 'omrader') {
  const ko = les();
  if (!Object.keys(ko.omrader ?? {}).length)
    console.log(
      'Ingen områder ennå: opprett med ko.mjs omrade <oid> --tittel "…" --prosjekter <pid> …\n',
    );
  for (const r of L.omradeOversikt(ko)) {
    const deler = [
      `${r.venter} venter`,
      `${r.klare} klare`,
      `${r.min_igjen} min igjen`,
      r.aktive ? `${r.aktive} aktive` : null,
      r.parkert ? `${r.parkert} parkert` : null,
      !r.i_register && r.oid !== L.UTEN_OMRADE ? 'ikke i registeret' : null,
    ].filter(Boolean);
    console.log(kutt(`${r.oid.padEnd(18)} ${deler.join(' · ')}`, BREDDE));
    const info = [r.tittel, r.beskrivelse].filter(Boolean).join(' · ');
    if (info) console.log(`  ${kutt(info, BREDDE - 2)}`);
    if (r.prosjekter.length)
      console.log(`  ${kutt(`prosjekter: ${r.prosjekter.join(', ')}`, BREDDE - 2)}`);
  }
} else if (kmd === 'fokus') {
  const under = a[1];
  if (under === 'sett') {
    const rekkefolge = posisjonelle(2, ['--resten', '--til', '--navn', '--av']);
    const resten = verdi('--resten');
    const r = endre((ko) => {
      const s = L.settFokus(ko, {
        rekkefolge,
        resten: resten ?? undefined,
        til: verdi('--til') ?? null,
        navn: verdi('--navn') ?? null,
        dra_med_avhengigheter: !a.includes('--uten-avhengigheter'),
        satt_av: verdi('--av') ?? null,
      });
      if (s.feil.length) dø(`Fokus ikke endret:\n  ${s.feil.join('\n  ')}`);
      return { s, tekst: L.fokusTekst(ko) };
    });
    console.log(`Fokus satt: ${r.tekst}`);
    for (const x of r.s.advarsler) console.log(`ADVARSEL: ${x}`);
  } else if (under === 'lagre') {
    // Planvisningen på tavla lagrer fokus og pause-endringene (kolonnen «Venter») i ÉN endring, alt eller
    // ingenting (koLogikk.lagreFokusPlan). --torr regner på en kopi og skriver ingenting; --forvent-endret nekter med
    // exit 6 når køen er endret etter forhåndsvisningen; --json svarer med én JSON-linje (til tavla).
    const fil = verdi('--fil');
    if (!fil)
      dø('fokus lagre --fil <plan.json> [--torr] [--forvent-endret <iso>] [--json] [--av "…"]');
    let inn;
    try {
      inn = JSON.parse(fs.readFileSync(fil, 'utf8'));
    } catch (e) {
      dø(`kunne ikke lese ${fil}: ${e?.message ?? e}`);
    }
    const json = a.includes('--json');
    const naa = new Date().toISOString();
    const plan = { ...inn, satt_av: verdi('--av') ?? inn?.satt_av ?? null };
    const feilUt = (s) => {
      if (!json) dø(`Fokus ikke endret:\n  ${s.join('\n  ')}`);
      console.log(JSON.stringify({ ok: false, feil: s }));
      if (harLas) fs.rmSync(LAS, { recursive: true, force: true });
      process.exit(1);
    };
    const svar = (ko, r, torr) => {
      if (json)
        console.log(
          JSON.stringify({
            ok: true,
            torr,
            endret: ko.endret ?? null,
            fokus: r.fokus,
            fjernet: r.fjernet,
            pauset: r.pauset,
            fortsatt: r.fortsatt,
            advarsler: r.advarsler,
          }),
        );
      else {
        console.log(
          `${torr ? 'Tørrkjøring (ingenting skrevet): ' : ''}` +
            (r.fokus ? `fokus ${L.fokusTekst({ ...ko, fokus: r.fokus })}` : 'ingen fokus') +
            `${r.pauset.length ? ` · pause: ${r.pauset.join(', ')}` : ''}` +
            `${r.fortsatt.length ? ` · fortsetter: ${r.fortsatt.join(', ')}` : ''}`,
        );
        for (const x of r.advarsler) console.log(`ADVARSEL: ${x}`);
      }
    };
    if (a.includes('--torr')) {
      const ko = les();
      sjekkForvent(ko);
      const r = L.lagreFokusPlan(L.klonJson(ko), plan, naa);
      if (r.feil.length) feilUt(r.feil);
      svar(ko, r, true);
    } else {
      let etter = null;
      const r = endre((ko) => {
        sjekkForvent(ko);
        const s = L.lagreFokusPlan(ko, plan, naa);
        if (s.feil.length) feilUt(s.feil);
        etter = ko;
        return s;
      });
      svar(etter, r, false);
    }
  } else if (under === 'av') {
    const gammelt = endre((ko) => L.fjernFokus(ko));
    console.log(
      gammelt
        ? 'Fokus fjernet: køen rangeres som før (score og prosjekttillegg).'
        : 'Ingen fokus var satt.',
    );
  } else if (under && !under.startsWith('--')) {
    dø(
      'fokus | fokus sett <trinn> [<trinn> …] [--resten vent|fyll] [--til <dato>] [--navn "…"] [--uten-avhengigheter] | fokus av',
    );
  } else {
    const ko = les();
    if (!ko.fokus) {
      console.log(
        'Ingen fokus satt: køen rangeres etter score og prosjekttillegg.\n' +
          'Sett: ko.mjs fokus sett omrade:<oid> prosjekt:<pid> funksjon:<pid>/<navn> … [--resten vent|fyll] [--til <dato>]',
      );
    } else {
      const ucommittet = ucommittetStier();
      const kanStarte = L.velgNeste(ko, Date.now(), { ucommittet });
      const st = L.fokusStatus(ko, { kanStarte: kanStarte.map((v) => v.id) });
      console.log(kutt(`FOKUS${st.navn ? ` «${st.navn}»` : ''}: ${st.tekst}`, BREDDE));
      const f = ko.fokus;
      console.log(
        `  satt ${f.fra ?? '?'}${f.satt_av ? ` av ${f.satt_av}` : ''}` +
          ` · dra med avhengigheter: ${f.dra_med_avhengigheter === false ? 'nei' : 'ja'}` +
          `${st.utlopt ? ' · UTLØPT' : ''}${st.ikke_startet ? ' · ikke startet ennå' : ''}`,
      );
      if (st.aktiv) {
        st.per_trinn.forEach((t, i) =>
          console.log(
            kutt(
              `  T${i + 1} ${t.trinn.padEnd(30)} ${t.venter} venter · ${t.klare} klare · ${t.min_igjen} min igjen`,
              BREDDE,
            ),
          ),
        );
        console.log(
          `  ${st.klare} klare i fokus · ${st.pagar} pågår · ${st.dratt_med} dratt med · ${st.kan_starte} startes nå`,
        );
        const dratt = L.drattMed(ko);
        if (dratt.size) {
          const liste = [...dratt.entries()]
            .slice(0, 12)
            .map(([id, d]) => `${id} (T${d.trinn + 1}, av ${d.av})`)
            .join(', ');
          console.log(
            kutt(`  Dratt med: ${liste}${dratt.size > 12 ? ` +${dratt.size - 12}` : ''}`, BREDDE),
          );
        }
        if (st.eiersporsmal.length)
          console.log(
            kutt(
              `  Eierspørsmål i fokus: ${st.eiersporsmal
                .slice(0, 5)
                .map((s) => `${s.sp} (${s.oppgaver})`)
                .join(' · ')}`,
              BREDDE,
            ),
          );
        console.log('NESTE OPP:');
        if (!kanStarte.length) console.log('  ingenting kan startes nå (se vis og tilstand)');
        for (const v of kanStarte)
          console.log(
            kutt(
              `  ${v.id.padEnd(12)} ${v.klasse.padEnd(3)} ${`${v.anslag} min`.padEnd(8)} prio ${v.score}  ${L.stegTekst(v)}`,
              BREDDE,
            ),
          );
      }
      if (st.varsel) console.log(`VARSEL: ${st.varsel}`);
    }
  }
} else if (kmd === 'parker') {
  const ider = posisjonelle(1, ['--grunn', '--til', '--av', '--forvent-endret']);
  const r = endreLogget('parker', (ko) => {
    const s = L.parker(ko, ider, {
      av: verdi('--av'),
      grunn: verdi('--grunn') ?? null,
      til: verdi('--til') ?? null,
    });
    if (s.feil.length) dø(`Ingenting parkert:\n  ${s.feil.join('\n  ')}`);
    return s;
  });
  console.log(
    `Parkert (står til ko.mjs fortsett${verdi('--til') ? ' eller datoen' : ''}): ${r.parkert.join(', ')}`,
  );
  for (const x of r.advarsler) console.log(`ADVARSEL: ${x}`);
  if (angreHint()) console.log(angreHint());
} else if (kmd === 'fortsett') {
  const ider = posisjonelle(1, ['--av', '--forvent-endret']);
  const r = endreLogget('fortsett', (ko) => {
    const s = L.fortsett(ko, ider);
    if (s.feil.length) dø(`Ingenting endret:\n  ${s.feil.join('\n  ')}`);
    return s;
  });
  if (r.fortsatt.length) console.log(`Av vent: ${r.fortsatt.join(', ')}`);
  if (r.ikkeParkert.length) console.log(`Var ikke parkert: ${r.ikkeParkert.join(', ')}`);
  if (angreHint()) console.log(angreHint());
} else if (kmd === 'ranger') {
  // ---- Blokkflytting ----
  // Flytter oppgavene samlet innen fokustrinnet og beholder rekkefølgen de hadde innbyrdes (koLogikk.rangerBlokk), ved å
  // skrive nye prioritet_tillegg i ett endre-mange (alt eller ingenting).
  const ider = posisjonelle(1, ['--over', '--under', '--av', '--forvent-endret']);
  const plass = {
    topp: a.includes('--topp'),
    bunn: a.includes('--bunn'),
    over: verdi('--over') ?? null,
    under: verdi('--under') ?? null,
  };
  const naa = new Date().toISOString();
  // --json gir svaret (og feilene) som JSON til tavla, som endre-mange --json.
  const json = a.includes('--json');
  const nei = (feil) => {
    if (!json) dø(`Ingenting flyttet:\n  ${feil.join('\n  ')}`);
    console.log(JSON.stringify({ ok: false, feil }));
    if (harLas) fs.rmSync(LAS, { recursive: true, force: true });
    process.exit(1);
  };
  const beregn = (ko) => {
    const rb = L.rangerBlokk(ko, ider, plass, Date.parse(naa));
    if (rb.feil.length) nei(rb.feil);
    const oppgaver = Object.entries(rb.endringer).map(([id, t]) => ({ id, prioritet_tillegg: t }));
    return { rb, oppgaver };
  };
  if (a.includes('--torr')) {
    const ko = les();
    sjekkForvent(ko);
    const { rb, oppgaver } = beregn(ko);
    const s = L.endreMange(ko, oppgaver, { av: avNavn(), naa, torr: true });
    if (s.feil.length) nei(s.feil);
    if (json)
      console.log(
        JSON.stringify({
          ok: true,
          torr: true,
          endret: ko.endret ?? null,
          endringer: s.endringer,
          advarsler: rb.advarsler,
        }),
      );
    else {
      console.log(
        `Tørrkjøring (ingenting skrevet): ${s.endringer.length} prioritet(er) endres. Køens versjon: ${ko.endret ?? '(ingen)'}`,
      );
      for (const l of L.diffLinjer(s.endringer)) console.log(`  ${l}`);
      for (const x of rb.advarsler) console.log(`ADVARSEL: ${x}`);
    }
  } else {
    const r = endreLogget('ranger', (ko) => {
      const { rb, oppgaver } = beregn(ko);
      const s = L.endreMange(ko, oppgaver, { av: avNavn(), naa });
      if (s.feil.length) nei(s.feil);
      return { ...s, advarsler: rb.advarsler };
    });
    if (json) {
      console.log(
        JSON.stringify({
          ok: true,
          endret: r.endret,
          endringer: r.endringer,
          advarsler: r.advarsler,
          logg: sistePost?.nr ?? null,
        }),
      );
      process.exit(0);
    }
    const hvor = plass.topp
      ? 'øverst i trinnet'
      : plass.bunn
        ? 'nederst i trinnet'
        : plass.over
          ? `rett over ${plass.over}`
          : `rett under ${plass.under}`;
    console.log(`Flyttet ${r.endret.length} oppgave(r) ${hvor}: ${r.endret.join(', ')}`);
    for (const x of r.advarsler) console.log(`ADVARSEL: ${x}`);
    if (angreHint()) console.log(angreHint());
  }
} else if (kmd === 'angre') {
  // ---- Angre siste ----
  // Ruller tilbake den siste posten i endringsloggen som ikke er angret, når feltene fortsatt har verdien posten satte.
  const json = a.includes('--json');
  const postTekst = (p) =>
    `nr. ${p.nr} ${p.handling} av ${p.av} ${p.at} (${p.endringer.length} felt)`;
  // --nr <n> = angre bare når den siste angrbare posten er nr. n (tavlas «Angre» etter en massehandling;
  // har noen andre skrevet en logget endring siden, angres ikke deres i stedet).
  const nrFeil = (ko) => {
    if (verdi('--nr') == null) return null;
    const siste = L.sisteAngrbare(ko);
    return siste && String(siste.nr) === String(verdi('--nr'))
      ? null
      : `den siste endringen som kan angres er ${siste ? `nr. ${siste.nr} (${siste.handling} av ${siste.av})` : 'ingen'}, ikke nr. ${verdi('--nr')}; ingenting angret`;
  };
  if (a.includes('--vis')) {
    const ko0 = les();
    const nf = nrFeil(ko0);
    const s = nf ? { feil: [nf], post: L.sisteAngrbare(ko0) } : L.angrePost(ko0, { vis: true });
    if (json)
      console.log(JSON.stringify({ ok: !s.feil.length, feil: s.feil, post: s.post ?? null }));
    else if (!s.post) console.log(s.feil.join('\n'));
    else {
      console.log(`Siste som kan angres: ${postTekst(s.post)}`);
      for (const l of L.diffLinjer(s.post.endringer)) console.log(`  ${l}`);
      console.log(
        s.feil.length
          ? `Kan IKKE angres nå:\n  ${s.feil.join('\n  ')}`
          : 'Kan angres (ko.mjs angre).',
      );
    }
  } else {
    const naa = new Date().toISOString();
    const r = endre((ko) => {
      sjekkForvent(ko);
      const nf = nrFeil(ko);
      const s = nf ? { feil: [nf], post: null } : L.angrePost(ko, { av: avNavn(), naa });
      if (s.feil.length) {
        if (json) {
          console.log(JSON.stringify({ ok: false, feil: s.feil, post: s.post ?? null }));
          if (harLas) fs.rmSync(LAS, { recursive: true, force: true });
          process.exit(1);
        }
        dø(`Ingenting angret${s.post ? ` (${postTekst(s.post)})` : ''}:\n  ${s.feil.join('\n  ')}`);
      }
      return s;
    });
    if (json) console.log(JSON.stringify({ ok: true, post: r.post }));
    else {
      console.log(`Angret ${postTekst(r.post)}:`);
      for (const l of L.diffLinjer(
        r.post.endringer.map((e) => ({ ...e, for: e.etter, etter: e.for })),
      ))
        console.log(`  ${l}`);
    }
  }
} else if (kmd === 'plan') {
  // ---- Planregisteret (se toppen av fila og lib/koPlan.js) ----
  planKommando();
} else if (kmd === 'klassifiser') {
  // ---- Forslag til prosjekt ----
  // Samme forslag som add skriver (koLogikk.foreslaProsjekt): lengste prefiks, planen i kilde/oppdrag, filrot. Uten
  // --utfor endres ingenting.
  const json = a.includes('--json');
  const radTekst = (r) => `  ${r.id.padEnd(14)} ${r.naa} → ${r.forslag ?? '?'}  (${r.grunn})`;
  if (verdi('--fil')) {
    const innhold = JSON.parse(fs.readFileSync(verdi('--fil'), 'utf8'));
    const nye =
      innhold && !Array.isArray(innhold) && innhold.id === undefined && 'oppgaver' in innhold
        ? [].concat(innhold.oppgaver ?? [])
        : [].concat(innhold);
    const register = les().prosjekter ?? {};
    const rader = nye.map((n) => ({ id: n?.id ?? '(uten id)', ...L.foreslaProsjekt(n, register) }));
    if (json) console.log(JSON.stringify({ ok: true, forslag: rader }));
    else
      for (const r of rader)
        console.log(
          `  ${String(r.id).padEnd(14)} ${r.pid ?? 'Sorter'}${r.signal ? ` (${r.signal})` : ''}: ${r.grunn}${r.sikker ? '' : ' [usikker]'}`,
        );
  } else {
    const filter = { utenProsjekt: a.includes('--uten-prosjekt'), uenige: a.includes('--uenige') };
    if (a.includes('--utfor')) {
      const r = endreLogget('klassifiser', (ko) => {
        const k = L.klassifiserKo(ko, filter);
        if (!k.flytt.length) return { ...k, endret: [] };
        const s = L.endreMange(
          ko,
          k.flytt.map((x) => ({ id: x.id, prosjekt: x.forslag })),
          { av: avNavn() },
        );
        if (s.feil.length) dø(`Ingenting endret:\n  ${s.feil.join('\n  ')}`);
        return { ...k, endret: s.endret };
      });
      if (json) console.log(JSON.stringify({ ok: true, ...r, logg: sistePost?.nr ?? null }));
      else {
        console.log(`Satt prosjekt på ${r.endret.length} oppgave(r).`);
        for (const x of r.flytt) console.log(radTekst(x));
        if (r.sorter.length)
          console.log(`Sorter (${r.sorter.length}; avgjøres av eieren, endres ikke automatisk):`);
        for (const x of r.sorter) console.log(radTekst(x));
        if (angreHint()) console.log(angreHint());
      }
    } else {
      const k = L.klassifiserKo(les(), filter);
      if (json) console.log(JSON.stringify({ ok: true, ...k }));
      else {
        console.log(
          `Forslag (${k.flytt.length}; settes med ko.mjs klassifiser --utfor${filter.utenProsjekt ? ' --uten-prosjekt' : ''}${filter.uenige ? ' --uenige' : ''}):`,
        );
        for (const x of k.flytt) console.log(radTekst(x));
        console.log(
          `Sorter (${k.sorter.length}; usikre eller uenige, rett med ko.mjs endre-mange --fil <json> [{ "id", "prosjekt" }]):`,
        );
        for (const x of k.sorter) console.log(`${radTekst(x)} [${x.type}]`);
        const pre = L.prefiksAdvarsler(les().prosjekter ?? {});
        for (const x of pre) console.log(`ADVARSEL: ${x}`);
      }
    }
  }
} else {
  dø(
    'Bruk: ko.mjs <init|add|godkjenn|vis|neste|start|sett|endre|avklar|avklaringer|sporsmal|grense|tilstand|sporfil|' +
      'prosjekter|prosjekt|endre-mange|plukkbare|plukk|lever|slipp|qa|ekstern|orkestrator|sky|sky-pakke|samle|' +
      'omrade|omrader|fokus|parker|fortsett|ranger|angre|klassifiser|plan|fyll|motta|flett|info|aktive|neste-migr|' +
      'kapasitet|kompakt|diagnose|kost> …  (se toppen av fila)',
    kmd ? 1 : 0,
  );
}

// ---- ko.mjs sky: egnethet med git --------------------------------------------------------------------
/** <remote>/<basegren> og stiene som er endret lokalt siden den (committet og ikke pushet, pluss ucommittet). */
function skyKontekst() {
  const pushetHead =
    gitLes(['rev-parse', '-q', '--verify', `refs/remotes/${REMOTE}/${BASE}`])?.trim() || null;
  const endret = new Set();
  if (pushetHead) {
    const diff = gitLes(['diff', '--name-only', `refs/remotes/${REMOTE}/${BASE}...${BASE}`]);
    for (const s of String(diff ?? '').split('\n')) if (s.trim()) endret.add(s.trim());
  }
  for (const s of ucommittetStier()) endret.add(s);
  return { pushetHead, endret: [...endret] };
}

/** Oppdragsteksten og egnetheten for én oppgave. */
function skyVurder(ko, o, kontekst = skyKontekst()) {
  const fil = oppdragFil(o);
  const tekst = fil ? fs.readFileSync(fil, 'utf8') : String(o.oppdrag ?? '');
  const egenSti = fil ? String(o.oppdrag) : null;
  const egnethet = L.skyEgnet(ko, o.id, { ...kontekst, oppdragTekst: tekst, egenSti });
  return { tekst, egenSti, egnethet };
}

// ---- ko.mjs ekstern: skanning (bare lesing) ------------------------------------------------------------------
function eksternVindu(ko) {
  if (a.includes('--alle')) {
    const tider = ko.oppgaver
      .filter((o) => !L.erEksternRad(o) && L.KOLLISJON_STATUSER.includes(o.status))
      .map((o) => Date.parse(o.lagt_til ?? ''))
      .filter(Number.isFinite);
    const ms = tider.length ? Math.min(...tider) : Date.now() - 86_400_000;
    return {
      vindu: { siden: new Date(ms).toISOString() },
      tekst: 'siden den eldste oppgaven i arbeid ble lagt inn',
    };
  }
  const s = verdi('--siden');
  if (s) {
    const m = /^(\d+)\s*([td])$/i.exec(s);
    if (m) {
      const ms = Number(m[1]) * (m[2].toLowerCase() === 't' ? 3_600_000 : 86_400_000);
      return { vindu: { siden: new Date(Date.now() - ms).toISOString() }, tekst: `siste ${s}` };
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(s) && Number.isFinite(Date.parse(s)))
      return { vindu: { siden: new Date(Date.parse(s)).toISOString() }, tekst: `siden ${s}` };
    return { vindu: { fra: s }, tekst: `${s}..${BASE}` };
  }
  if (gitLes(['rev-parse', '-q', '--verify', `refs/remotes/${REMOTE}/${BASE}`]) != null)
    return {
      vindu: { fra: `${REMOTE}/${BASE}` },
      tekst: `ikke pushet (${REMOTE}/${BASE}..${BASE})`,
    };
  return {
    vindu: { siden: new Date(Date.now() - 86_400_000).toISOString() },
    tekst: `siste 24 t (fant ikke ${REMOTE}/${BASE})`,
  };
}

function eksternSkann() {
  const ko = les();
  // --id <id>: bare den ene oppgaven, med vinduet fra den ble lagt inn (samme sjekk som start/plukk/sporfil gjør).
  const bareId = verdi('--id');
  if (bareId) {
    const o = ko.oppgaver.find((x) => x.id === bareId);
    if (!o) dø(`Ukjent oppgave ${bareId}`);
    const v = G.eksternForOppgaver(gitLes, [{ ...o, status: 'venter' }]).get(bareId);
    for (const f of v.feil) console.log(`ADVARSEL: ${f}`);
    console.log(
      `${bareId} (${o.status}), lagt inn ${o.lagt_til ?? '?'}: ${v.kollisjoner.length} kollisjon(er), ` +
        `${v.nevnt.length} commit(s) utenfor køen som nevner id-en.`,
    );
    for (const k of v.kollisjoner) console.log(`  ${L.kollisjonTekst(k, { medId: false })}`);
    for (const c of v.nevnt)
      console.log(
        `  nevnt i ${c.kort} «${c.emne}»${o.status === 'venter' ? ` → gjort? ko.mjs ekstern godta ${bareId} ${c.kort}` : ''}`,
      );
    if (!v.kollisjoner.length && !v.nevnt.length)
      console.log('  Ingenting utenfor køen berører den.');
    return;
  }
  const { vindu, tekst } = eksternVindu(ko);
  const b = G.eksternBilde(gitLes, ko, { vindu });
  if (a.includes('--json')) {
    // Uten meldingstekstene (lange); emne, filer og kilde holder.
    const uten = (c) => ({
      ...c,
      melding: undefined,
      side: (c.side ?? []).map((s) => ({ sha: s.sha, emne: s.emne, kilde: s.kilde })),
    });
    console.log(
      JSON.stringify(
        { vindu: tekst, ...b, commits: b.commits.map(uten), eksterne: b.eksterne.map(uten) },
        null,
        2,
      ),
    );
    return;
  }
  const maks = Number(verdi('--maks') ?? 20) || 20;
  const dato = (d) =>
    String(d ?? '')
      .slice(0, 16)
      .replace('T', ' ');
  const filtekst = (filer, n = 6) =>
    filer.length
      ? `${filer.slice(0, n).join(', ')}${filer.length > n ? ` (+${filer.length - n})` : ''}`
      : '(ingen filer)';
  const ut = [`Arbeid utenfor køen (vindu: ${tekst}):`];
  for (const f of b.feil) ut.push(`ADVARSEL: ${f}`);

  // (a) Commits på basegrenen som ikke kommer fra køen.
  const tell = (k) => b.commits.filter((c) => c.kilde === k).length;
  ut.push('');
  ut.push(
    `(a) Commits på ${BASE} som ikke kommer fra køen: ${b.eksterne.length} ` +
      `(av ${b.commits.length} på første-forelder-linja; ${tell('ko')} fra køen, ${tell('orkestrator')} fra orkestratoren)`,
  );
  const perSha = new Map();
  for (const s of b.samsvar) perSha.set(s.sha, [...(perSha.get(s.sha) ?? []), s]);
  for (const c of b.eksterne.slice(0, maks)) {
    ut.push(`  ${c.kort}  ${dato(c.dato)}  ${kutt(c.emne, BREDDE - 30)}`);
    ut.push(`            filer: ${kutt(filtekst(c.filer), BREDDE - 19)}`);
    const side = (c.side ?? []).filter((s) => s.kilde === 'ekstern');
    if (side.length) ut.push(`            flett som tar med ${side.length} commit(s) utenfor køen`);
    const nevner = perSha.get(c.sha) ?? [];
    if (nevner.length)
      ut.push(`            nevner: ${nevner.map((s) => `${s.id} (${s.status})`).join(', ')}`);
  }
  if (b.eksterne.length > maks) ut.push(`  … og ${b.eksterne.length - maks} eldre (--maks N)`);

  // (b) Grener og worktrees utenfor køgrenene.
  ut.push('');
  ut.push(
    `(b) Grener og worktrees utenfor ${PREFIKS}* med commits som ikke er i ${BASE}: ${b.grener.length}`,
  );
  for (const g of b.grener) {
    ut.push(
      `  ${g.navn}  ${g.antall} commit(s)${g.siste ? `, siste ${dato(g.siste)}` : ''}${g.worktree ? `  worktree ${g.worktree}` : ''}`,
    );
    ut.push(`            filer: ${kutt(filtekst(g.filer), BREDDE - 19)}`);
  }

  // (c) Ucommittet i hovedtreet.
  const sporet = b.ucommittet.filter((u) => !u.usporet);
  const usporet = b.ucommittet.filter((u) => u.usporet);
  ut.push('');
  ut.push(
    `(c) Ucommittet i hovedtreet: ${sporet.length} endret, ${usporet.length} usporet${usporet.length && !a.includes('--usporet') ? ' (--usporet viser dem)' : ''}`,
  );
  for (const u of [...sporet, ...(a.includes('--usporet') ? usporet : [])].slice(0, 40))
    ut.push(`  ${u.xy.trim().padEnd(2)} ${u.sti}`);

  // Registrert utenfor køen, og oppgaver uten prosjekt eller funksjon.
  ut.push('');
  ut.push(`Registrert utenfor køen (ekstern add): ${b.registrert.length || 'ingen'}`);
  for (const o of b.registrert)
    ut.push(
      kutt(
        `  ${o.id}  «${o.ekstern_navn}»  ${[...(o.eier_filer ?? []), ...(o.eier_db ?? [])].join(', ')}${o.gren ? `  gren ${o.gren}` : ''}`,
        BREDDE,
      ),
    );
  const { utenProsjekt, utenFunksjon } = b.mangler;
  // Oppgaver lagt inn uten prosjekt eller funksjon (f.eks. av en annen økt uten /legg-til-ko).
  const idTekst = (ider) => `${ider.slice(0, 8).join(', ')}${ider.length > 8 ? ' …' : ''}`;
  const mangler = [
    utenProsjekt.length ? `uten prosjekt ${utenProsjekt.length} (${idTekst(utenProsjekt)})` : null,
    utenFunksjon.length ? `uten funksjon ${utenFunksjon.length} (${idTekst(utenFunksjon)})` : null,
  ].filter(Boolean);
  if (mangler.length) {
    ut.push(kutt(`Oppgaver i arbeid ${mangler.join('; ')}.`, BREDDE));
    ut.push('  Rett med ko.mjs endre-mange --fil <json> ([{ "id", "prosjekt", "funksjon" }]).');
  }

  // Kollisjoner og samsvar.
  ut.push('');
  ut.push(
    `Kollisjoner med eierfilene (kjørende, plukkede, i review, ventende): ${b.kollisjoner.length}`,
  );
  for (const k of b.kollisjoner.slice(0, 30))
    ut.push(
      kutt(`  ${L.kollisjonTekst(k).replace(`${k.id}: `, `${k.id} (${k.status}): `)}`, BREDDE),
    );
  if (b.kollisjoner.length > 30) ut.push(`  … og ${b.kollisjoner.length - 30} til (--json)`);
  const forslag = b.samsvar.filter((s) => s.forslag);
  if (forslag.length) {
    ut.push('');
    ut.push(
      'Samsvar: eksterne commits nevner ventende oppgaver. Er de gjort? Godta bare etter å ha sett på commiten:',
    );
    for (const s of forslag) ut.push(kutt(`  ${s.forslag}   «${s.emne}»`, BREDDE));
  }
  console.log(ut.join('\n'));
}
