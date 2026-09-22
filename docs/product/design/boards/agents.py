"""Board: Agents — the credential surface.

Round E, screen 7. The one screen where grants and autonomy move, so every panel
is built around making the owner's own change legible to them.
"""
from lib import *

CW,CH=2300,3560

def window(T):
    return (f'<div style="border: 1px solid {T["bc"]}; border-radius: 14px; overflow: hidden; flex-grow: 1; '
            f'min-width: 0; background: {T["bg"]};">{toolbar(T)}'
            f'<div style="display: flex; align-items: stretch;">{sidebar8(T,"Agents")}{roster(T)}</div></div>')

PRES=pan(L,"FIVE COMPUTED STATES, TWO COLOURS",
  '<table style="width: 100%; border-collapse: collapse; font-size: 12.5px;">'
  + f'<tr style="color: {L["tt"]}; text-align: left; font-size: 11px; font-weight: 700; letter-spacing: 0.06em;">'
    f'<th style="padding: 0 12px 8px 0;">STATE</th><th style="padding: 0 12px 8px 0;">DRAWN</th>'
    f'<th style="padding: 0 12px 8px 0;">CHANNEL</th><th style="padding: 0 0 8px 0;">WHY</th></tr>'
  + "".join(f'<tr style="border-top: 1px solid {L["border"]};">'
    f'<td style="padding: 9px 12px 9px 0;">{mono(s,L["tp"],12)}</td>'
    f'<td style="padding: 9px 12px 9px 0;"><span style="display: inline-flex; align-items: center; gap: 8px;">'
    f'{presdot(L,s)}<span style="color: {L["ts"]};">{d}</span></span></td>'
    f'<td style="padding: 9px 12px 9px 0; color: {L["tp"]}; font-weight: 600;">{c}</td>'
    f'<td style="padding: 9px 0; color: {L["ts"]};">{w}</td></tr>'
    for s,d,c,w in [
      ("working","filled","none","the normal case, and the claim is named in the row"),
      ("queued","filled, hollow centre","none","waiting is not a fault"),
      ("idle","hollow","none","<b>and no word.</b> The resting state does not announce itself"),
      ("interrupted","degraded","tint","an expired lease still holds the claim"),
      ("over-cap","degraded","tint","a bundle of its own is blocked for exceeding a cap")])
  + '</table>'
  + nt(L,"Five states invites five colours and four of them would be wrong. Tint carries <b>something is wrong</b> "
        "and nothing else, so only the two that <i>are</i> wrong get it — and they are <b>degraded</b>, not "
        "<b>failed</b>, because a lease that lapsed while an agent was thinking did not break (C36). An Agents "
        "screen with five colours is a screen where colour has stopped meaning anything.",14))

AUTOP=pan(L,"THE EFFECTIVE TABLE IS THE ANSWER — AND TWO REASONS A CELL IS NOT ALLOW",
  autoblock(L)
  + nt(L,"<b>The level is a ceiling, not a synonym for the table.</b> <b>effectiveActions()</b> resolves each kind "
        "to the lower of its stored entry and the ceiling, and the CLI already shows the resolved table. If the "
        "console showed the stored one the two would disagree about what an agent can do, and the console would "
        "be the one that is wrong.",14)
  + f'<div style="display: flex; gap: 14px; margin-top: 14px;">'
  + "".join(f'<div style="flex-grow: 1; flex-basis: 0; background: {L["sunken"]}; border-radius: 10px; padding: 12px 14px;">'
            f'<div style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {L["tt"]}; '
            f'margin-bottom: 7px;">{h}</div>'
            f'<div style="font-size: 12px; color: {L["tp"]}; line-height: 1.55;">{b}</div></div>'
    for h,b in [
      ("DEFAULTED","You set nothing; this is <b>ACTION_DEFAULTS</b> for this level. <b>dispatch</b> is the one kind "
       "that stays <b>propose</b> even at <b>act_within_scope</b> — off-machine is a human decision by default."),
      ("CLAMPED","You set something the level does not permit. The stored value is shown dimmed beside the "
       "effective one. Blurring this into <i>defaulted</i> would hide the only case where the owner's own setting "
       "is being overridden — which is the case they most need to see.")])
  + '</div>'
  + nt(L,"Mode is drawn in the <b>weight</b> channel: <b>allow</b> filled, <b>propose</b> outlined, <b>deny</b> "
        "hollow and dashed. Never green-for-allow and red-for-deny — a configuration is not a moral position, and "
        "red is spoken for by <b>failed</b>. Same argument as the priority badge, and it holds for the same reason.",12))

WIDEN=pan(L,"WIDENING IS A DIFFERENT ACT FROM NARROWING",
  f'<div style="display: flex; gap: 16px; align-items: flex-start;">'
  + f'<div style="flex-grow: 1; flex-basis: 0; background: {L["surface"]}; border: 1px solid {L["bs"]}; '
    f'border-radius: 12px; padding: 16px; box-shadow: 0 8px 26px rgba(26,24,21,0.12);">'
    f'<div style="font-size: 13.5px; font-weight: 600; color: {L["tp"]};">Widen what research-crew may do?</div>'
    f'<div style="font-size: 12px; color: {L["ts"]}; line-height: 1.55; margin-top: 5px;">'
    f'Two things gain room:</div>'
    f'<div style="background: {L["sunken"]}; border-radius: 9px; padding: 11px 13px; margin-top: 10px;">'
  + "".join(f'<div style="padding: 3px 0;">{mono(s,L["tp"],12)}</div>'
            for s in ["level observe → propose","actions.comment deny → propose"])
  + f'</div>'
    f'<div style="font-size: 11.5px; color: {L["ts"]}; line-height: 1.5; margin-top: 10px;">'
    f'These are <b>autonomyWidenings</b>&rsquo; own strings. The design does not compute consequences; it renders '
    f'that list.</div>'
    f'<div style="display: flex; align-items: center; gap: 8px; margin-top: 14px;">'
  + btn(L,"Widen","affirm") + btn(L,"Cancel","ghost") + '</div></div>'
  + f'<div style="flex-grow: 1; flex-basis: 0; display: flex; flex-direction: column; gap: 12px;">'
  + "".join(f'<div style="background: {L["surface"]}; border: 1px solid {L["border"]}; border-radius: 11px; padding: 13px 15px;">'
            f'<div style="font-size: 12.5px; font-weight: 600; color: {L["tp"]};">{h}</div>'
            f'<div style="font-size: 12px; color: {L["ts"]}; line-height: 1.55; margin-top: 4px;">{b}</div></div>'
    for h,b in [
      ("A narrowing applies on commit","No confirmation. Taking room away needs no ceremony, and asking for one "
       "teaches the owner to click through the dialog that matters."),
      ("A no-op is not a widening","<b>autonomyWidenings</b> is computed on the <i>effective</i> tables, so raising "
       "a stored entry under an unchanged ceiling — which changes nothing — is not called a widening."),
      ("A 409 sent nothing","<b>PUT</b> replaces the record and answers 409 on a concurrent change. Same treatment "
       "as a stale request card: the new values, and the edit offered again against them."),
      ("No success banner","The row now reads differently, which is the receipt. Every widening also writes "
       "<b>agent_admin / autonomy_widened</b> and raises one Needs You alert per change per 24h.")])
  + '</div></div>')

CREWP=pan(L,"A CREW IS READ-ONLY HERE",scopeblock(L,crew=True))

CEIL=pan(L,"THE RUNG THE OWNER NEVER SEES — C42 LANDS HERE",
  f'<div style="background: {L["bg"]}; border: 1px solid {L["border"]}; border-radius: 12px; overflow: hidden;">'
  + credrow(L,id_="taskuary",role="an agent",external=True,scope="titles",spend="—",seen="41m",state="idle",
      ceiling="asked twice for <b>Areas/Finance</b> · declined both · it can no longer ask",last=True)
  + '</div>'
  + nt(L,"<b>request_access</b> refuses a third ask after two declines, at the tool, with <i>ask the owner "
        "directly</i> — and that refusal writes <b>no proposal row</b>. So Needs You cannot show it: the queue goes "
        "quiet, and the quiet means the opposite of what quiet usually means.",14)
  + nt(L,"It belongs on the credential, with the two prior requests linked. Same shape as the successful collector "
        "pass Activity could not show: a fact that is invisible because nothing writes a row for it, parked on the "
        "surface that owns the object rather than on the timeline.",12))

STATESP=pan(L,"FOUR STATES, AND ONE OF THEM IS NOT AN EMPTY ROSTER",
  row(card(panel_state(L,I["agents"],L["tt"],"No credentials yet.",
        "An agent gets a token here, and nothing else gives it one.",action="New credential"),L)
    + card(panel_state(L,I["plug"],L["abs"],"Its manifest is missing.",
        "Not a failure — nothing broke, the file is not there.",
        reason="agents/ops/research-crew.md",action="Open the folder"),L)
    + card(panel_state(L,I["warn"],L["fail"],"Couldn't load agents.",
        "<b>Nothing is known</b>, so the roster is not drawn empty.",
        reason="agent_presence · connection refused",action="Try again"),L),14)
  + nt(L,"And <b>stale</b>: presence is a snapshot, so when the poll is behind the age rides the header and the "
        "rows keep their last values. Stale annotates; it never replaces (round C).",14))

FOUNDP=pan(L,"WHAT THIS SCREEN FOUND",
  "".join(f'<div style="display: flex; gap: 10px; align-items: flex-start; padding: 7px 0;'
          + ("" if i==5 else f' border-bottom: 1px solid {L["border"]};') + '">'
          f'<span style="font-family: {MONO}; font-size: 11px; color: {L["acc"]}; flex-shrink: 0; '
          f'padding-top: 2px; width: 34px;">{k}</span>'
          f'<span style="font-size: 12.5px; color: {L["ts"]}; line-height: 1.55;">{v}</span></div>'
  for i,(k,v) in enumerate([
    ("C48","<b>Round C&rsquo;s <i>stale</i> still has no home.</b> <b>agent_presence</b> has no collector notion and "
           "<b>activity_feed</b> takes <b>collector_run</b> only where <b>ok = false</b>, so a healthy collector is "
           "invisible in both. The state the product talks about most is drawable on no existing query — request C1."),
    ("C46","the effective table exists in <b>core</b> and nowhere in the interface. Every surface that shows "
           "autonomy has to call <b>effectiveActions</b> or they will disagree."),
    ("C47","<b>effectiveActions</b> returns the resolved mode and drops the reason, so this screen recomputes "
           "<i>defaulted vs clamped</i> from <b>ACTION_DEFAULTS</b> and <b>LEVEL_CEILING</b>. One return-type "
           "change would stop three surfaces guessing — request C2."),
    ("—","<b>agent_presence</b> excludes revoked agents, so the roster needs two sources for one list. What you "
         "revoked is the thing you come looking for after an incident."),
    ("—","<b>spend_today_usd</b> has nothing to compare it to — <b>over-cap</b> is about review bundles, not "
         "money. Either a per-agent budget exists somewhere I have not found, or the number is context-free and "
         "the row should not imply otherwise — request C3."),
    ("C45","<b>a failed consequential operation leaves the request pending</b> — an action writes "
           "<b>payload.error</b> and stays pending, and an access refusal does the same. I drew it once on the "
           "access card as a Needs You detail. It is a system-wide rule about how this product fails and belongs "
           "in <b>design-system.md</b> §2 beside the four states.")])))

body=(heading("ROUND E · SCREEN 7","Agents — the only screen where the credential moves",
   "Invariant 2 says a grant is the user&rsquo;s hand, and <b>ACTION_KINDS</b> deliberately excludes any change to "
   "grants or autonomy — so nothing an agent emits can reach what this screen edits. Everything here is the owner "
   "acting, and the screen&rsquo;s whole job is to make sure they know what they just did.",L)
  + row(window(L),18)
  + row(PRES+AUTOP,18)
  + row(WIDEN,18)
  + row(CREWP+CEIL,18)
  + row(STATESP,18)
  + row(FOUNDP,18)
  + row(f'<div style="background: {D["bg"]}; border-radius: 14px; padding: 22px; flex-grow: 1;">'
        + sub("DARK",D["tt"])
        + f'<div style="border: 1px solid {D["bc"]}; border-radius: 12px; overflow: hidden;">{roster(D)}</div></div>',18))
(PROJ/"Agents.dc.html").write_text(page("Agents",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote Agents.dc.html ({CW}x{CH})")
