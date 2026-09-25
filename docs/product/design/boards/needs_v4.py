"""Board: Needs You v4 — every ask, one pattern (2026-09-25).

Questions with context and several multiple-choice answers; pull requests to
review or reply to, answered in Metistry and posted to GitHub as the owner; the
C96 events and the meeting card as instances of the same five parts.
"""
from lib_needs import *
import lib_pwa as P

CW,CH=2600,9500

def col(*cards,gap=16):
    return f'<div style="display: flex; flex-direction: column; gap: {gap}px; flex-shrink: 0;">{"".join(cards)}</div>'
def lab(t,c): return f'<div style="flex-shrink: 0;">{sub(t,L["tt"])}{c}</div>'
def strip(*items): return f'<div style="display: flex; gap: 18px; align-items: flex-start; flex-wrap: wrap;">{"".join(items)}</div>'

PARTS=[("1","HEADER","type &middot; who asked (agent chip, or a person for GitHub) &middot; provenance &middot; age"),
       ("2","THE ASK","one line, the agent&rsquo;s title for what it needs"),
       ("3","CONTEXT","the agent&rsquo;s own words on the wash, then the retrieved things they rest on, as chips you can open"),
       ("4","BODY","one block from a closed set: <b>choices</b> &middot; <b>diff</b> &middot; <b>thread</b> &middot; <b>before and after</b> "
                 "&middot; <b>preview</b> &middot; <b>to-dos</b> &middot; <b>excerpt</b>"),
       ("5","ANSWERS","the type&rsquo;s primary verb, filled &middot; <b>Revise</b> (free text: <i>not quite &mdash; here&rsquo;s "
                    "what I mean</i>) &middot; Decline &middot; Later &middot; ?")]
RT=[("question","choices","Send Answers","Revise","Decline"),
    ("pull request","diff &middot; thread","Approve &middot; Reply","Request Changes","&mdash;"),
    ("access","before and after","Approve","Revise (narrow it)","Decline"),
    ("action","preview","Approve","Revise","Decline"),
    ("meeting","to-dos","Accept All","Revise","Decline All"),
    ("review","before and after &middot; preview","Approve &middot; Keep Mine","Revise &middot; Take the Other","Decline"),
    ("note &middot; improvement","preview &middot; before and after","Approve","Revise","Decline"),
    ("report","excerpt","its one act &mdash; Try Again, Reconnect","&mdash;","Dismiss"),
    ("invitation <i>(a source)</i>","preview","Accept","Maybe","Decline"),
    ("task <i>(a source)</i>","excerpt","Add to Today","&mdash;","&mdash; (Delegate)"),
    ("message <i>(Metis, from a source)</i>","excerpt","Draft Reply","&mdash;","Not Mine")]
def tbl(head,rows):
    th="".join(f'<th style="text-align: left; padding: 0 14px 7px 0; font-size: 10.5px; letter-spacing: 0.07em; color: {L["tt"]};">{h}</th>' for h in head)
    tr="".join(f'<tr style="border-top: 1px solid {L["border"]}; vertical-align: top;">'
               + "".join(f'<td style="padding: 8px 14px 8px 0; color: {L["tp"] if i==0 else L["ts"]}; font-weight: {600 if i==0 else 400}; line-height: 1.45;">{c}</td>'
                         for i,c in enumerate(r)) + '</tr>' for r in rows)
    return f'<table style="width: 100%; border-collapse: collapse; font-size: 12.5px;"><tr>{th}</tr>{tr}</table>'

PATTERN=pan(L,"ONE PATTERN FOR EVERYTHING AN AGENT NEEDS FROM YOU",
  "".join(f'<div style="display: flex; gap: 12px; padding: 8px 0; border-bottom: 1px solid {L["border"]};">'
          f'<span style="width: 22px; height: 22px; border-radius: 50%; background: {L["accq"]}; color: {L["acc"]}; font-size: 12px; '
          f'font-weight: 700; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;">{n}</span>'
          f'<div><div style="font-size: 11px; font-weight: 700; letter-spacing: 0.08em; color: {L["tp"]};">{h}</div>'
          f'<div style="font-size: 12.5px; color: {L["ts"]}; line-height: 1.5; margin-top: 2px;">{t}</div></div></div>' for n,h,t in PARTS)
  + '<div style="height: 14px;"></div>' + tbl(("TYPE","BODY","PRIMARY","REVISE","DECLINE"),RT)
  + nt(L,"<b>A new type is a row in this table, not a new card.</b> It picks one body block and names its primary "
         "verb; the Mac panel, the full window and the phone sheet all render it.",14)
  + nt(L,"<b>Revise is always free text</b> and always goes back to whoever asked &mdash; the course correction when "
         "the agent didn&rsquo;t get it quite right. <b>When an answer posts to another system, the button uses that "
         "system&rsquo;s word</b>: <i>Request Changes</i> is GitHub&rsquo;s, so it is Revise&rsquo;s name on a pull request.",12)
  + nt(L,"<b>Twelve types now</b> &mdash; question &middot; pull request &middot; access &middot; action &middot; meeting "
         "&middot; review &middot; note &middot; improvement &middot; report &middot; invitation &middot; task &middot; message. "
         "The bell is still the only badge.",12))

Q=pan(L,"QUESTION &mdash; SEVERAL QUESTIONS, CHOICES, CONTEXT, AND A WAY TO SAY &ldquo;NOT QUITE&rdquo;",
  strip(lab("OPEN",qcard(L)),lab("2 OF 3 ANSWERED",qcard(L,state="partial")),lab("READY &mdash; ONE ANSWERED IN WORDS",qcard(L,state="ready")),
        lab("REVISE &mdash; THE COURSE CORRECTION",qcard(L,state="revise")),lab("SENT",qcard(L,state="sent")))
  + nt(L,"<b>Any number of questions, each pick-one or pick-any</b>, and every one ends in <b>Something else&hellip;</b> "
         "&mdash; an answer in your own words, sent as that question&rsquo;s answer. <b>Send Answers</b> fills when every "
         "question has one.",14)
  + nt(L,"<b>Revise answers none of them</b>: it tells the agent the questions are the wrong questions. <b>Change</b> "
         "stays until the agent reads the answers. Context is the agent&rsquo;s prose; the chips beneath it are what it "
         "read, so you can check its premise before you answer.",12))

PR=pan(L,"PULL REQUEST &mdash; REVIEW AND APPROVE, OR REPLY TO A THREAD, WITHOUT LEAVING METISTRY",
  strip(lab("AN AGENT ASKS",prcard(L)),lab("GITHUB ASKS &mdash; A PERSON REQUESTED YOU",prcard(L,source="github")),
        lab("A CHECK IS FAILING",prcard(L,state="failing")),lab("APPROVE &mdash; WITH AN OPTIONAL COMMENT",prcard(L,state="approving")),
        lab("REQUEST CHANGES &mdash; WORDS REQUIRED",prcard(L,state="changes")))
  + '<div style="height: 18px;"></div>'
  + strip(lab("NEW COMMITS WHILE IT WAS OPEN",prcard(L,state="stale")),lab("NO WRITE TOKEN &mdash; ABSENT, NOT FAILED",prcard(L,state="nocred")),
          lab("APPROVED",prcard(L,state="approved")),lab("A REPLY IN A THREAD",threadcard(L)),lab("REPLIED AND RESOLVED",threadcard(L,state="replied")))
  + nt(L,"<b>Two ways in:</b> an agent that opens a PR asks for review with context, or GitHub&rsquo;s own review request "
         "arrives from the collector, attributed to the person who asked. <b>Approve, Request Changes, Comment, Reply and "
         "Resolve Conversation post to GitHub as you</b>, through the write token held in Resources &mdash; your act, not "
         "an agent&rsquo;s, so nothing widens what an agent can do.",14)
  + nt(L,"<b>A card never approves a head you didn&rsquo;t see:</b> new commits turn it stale and nothing is sent. A failing "
         "check is shown, not blocking; the review is yours to give.",12))

WIN=pan(L,"REVIEW CHANGES &mdash; THE FULL WINDOW, AT READING WIDTH",
  row(prwindow(L),18,"flex-start")
  + nt(L,"<b>Review Changes</b> opens the request in Needs You&rsquo;s own window: files on the left, the diff at reading "
         "width, the agent&rsquo;s note on what to read first above it. Comments on lines gather as drafts and go with the "
         "review, as on GitHub. <b>Open on GitHub</b> is always one click away.",14))

EV=pan(L,"THE SAME PATTERN, FOR WHAT C96 SENDS HERE &mdash; AND THE MEETING, MADE AT STOP",
  strip(lab("A BUDGET STOP &mdash; A QUESTION",budgetq(L)),lab("A ROUTINE FAILED &mdash; A REPORT",failreport(L)),
        lab("A TOKEN EXPIRED &mdash; ACCESS",credaccess(L)),lab("A KNOWLEDGE CONFLICT &mdash; A REVIEW",conflictreview(L)),
        lab("THE MEETING, AT STOP",meetingstop(L)))
  + nt(L,"<b>A budget stop is a question</b>, because it already is one in the code (two options, <b>budgets.ts</b>). "
         "<b>The meeting card arrives when you press Stop</b>, not at the evening fold: to-dos carry proposed due dates and "
         "people &mdash; tasks like any other, owed facets included &mdash; and <b>Draft Follow-up</b> writes the note to "
         "Kessler without sending it.",14))

RULES=[("Three kinds of asker","<b>Metis</b>, <b>an agent</b>, or <b>a source a collector reads</b> &mdash; GitHub, "
         "Calendar, Mail, Linear. The header says which, then the person there, if any."),
        ("A source must name you","A collector raises a request only when the source itself says it needs you: a "
         "review requested of you, an invitation to you, an issue assigned to you. Activity that merely mentions you "
         "stays in Activity (P2)."),
        ("Mirrors clear themselves","A request from a source <b>mirrors</b> it. Answer here and it posts there; answer "
         "there and the card clears here, with a receipt saying where. The source is the truth (collectors never invent)."),
        ("Metis may infer, and says so","Where the source doesn&rsquo;t ask &mdash; an email that seems to want a reply "
         "&mdash; Metis may raise it, as Metis, with its reason and <i>Metis thinks this needs you</i>. Inferred and "
         "reported never look alike (P5)."),
        ("One subject, one card","An agent&rsquo;s review ask and GitHub&rsquo;s review request for the same PR are one "
         "card with both askers on it."),
        ("Write-back is the source&rsquo;s word","Accept &middot; Maybe &middot; Decline for an invitation; Approve "
         "&middot; Request Changes for a PR. Where Metistry can&rsquo;t write back, the primary is <b>Open in &hellip;</b> "
         "or a draft &mdash; Mail is read-only, so a reply is drafted in Mail, never sent.")]
HUB=pan(L,"ONE HUB &mdash; METIS, AGENTS, AND WHAT THE COLLECTORS PICK UP",
  f'<div style="display: flex; gap: 20px; align-items: flex-start;">{panel5(L)}'
  f'<div style="flex-grow: 1; min-width: 0; display: flex; flex-direction: column; gap: 18px;">'
  + strip(lab("A CALENDAR INVITATION &mdash; FROM THE SOURCE",invitecard(L)),lab("AN EMAIL &mdash; METIS INFERRED IT",mailcard(L)),
          lab("A LINEAR ISSUE ASSIGNED TO YOU",issuecard(L)))
  + strip(lab("ANSWERED IN CALENDAR &mdash; CLEARED HERE",invitecard(L,state="cleared")),lab("APPROVED ON GITHUB &mdash; CLEARED HERE",ghcleared(L)))
  + "".join(f'<div style="display: flex; gap: 14px; padding: 8px 0; border-top: 1px solid {L["border"]};">'
            f'<span style="width: 210px; flex-shrink: 0; font-size: 12.5px; font-weight: 600; color: {L["tp"]};">{h}</span>'
            f'<span style="font-size: 12.5px; color: {L["ts"]}; line-height: 1.5;">{b}</span></div>' for h,b in RULES)
  + '</div></div>')

def psheet(T,title,inner,label):
    return P.phone(T,"",header=P.hdr(T,"Today",sub=F["day"]),overlay=P.sheet(T,title,inner),label=label)
PH=pan(L,"ON A PHONE",
  strip(psheet(L,"Needs You",qcard(L,state="partial",w=P.CWD),"A QUESTION"),
        psheet(L,"Needs You",prcard(L,w=P.CWD),"A PULL REQUEST"),
        psheet(L,"Needs You",threadcard(L,w=P.CWD),"A THREAD"),
        psheet(D,"Needs You",qcard(D,state="ready",w=P.CWD),"DARK"))
  + nt(L,"Same cards at 358pt. <b>Review Changes</b> on a phone pushes the file list, then one file&rsquo;s diff, "
         "wrapped; line comments are a long-press.",14))

body=(heading("NEEDS YOU &middot; v4","Everything an agent needs from you &mdash; one pattern",
        "The one place for everything that needs you &mdash; from Metis, from agents, and from what the collectors pick "
        "up in GitHub, Calendar, Mail and Linear &mdash; drawn with one pattern.",L)
  + row(panel4(L) + f'<div style="flex-grow: 1; min-width: 0; display: flex; flex-direction: column; gap: 20px;">{PATTERN}{Q}{PR}</div>',20,"flex-start")
  + row(HUB,20) + row(WIN,20) + row(EV,20) + row(PH,20)
  + row(f'<div style="background: {D["bg"]}; border-radius: 14px; padding: 22px; display: flex; gap: 20px; align-items: flex-start;">'
        + sub("DARK",D["tt"]) + panel4(D) + col(prcard(D),threadcard(D)) + col(meetingstop(D)) + '</div>',20))
(PROJ/"NeedsYou-v4.dc.html").write_text(page("Needs You v4",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote NeedsYou-v4.dc.html ({CW}x{CH})")
