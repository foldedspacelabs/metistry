"""Board: Settings ▸ Secrets and Variables (2026-09-25).

C116, C117. Secrets: per instance, in the Keychain, never shown again, sent only
to their hosts; {{ secret.name }}. A model never sees a value; a local run gets a
granted secret as an environment variable. Variables: shared plain values,
{{ variable.name }}, usable anywhere including an agent's instructions.
"""
from lib import *
from lib_connect import *

CW,CH=2720,2000
def sw(T,sel,inner): return settingswindow(T,inner,sel=sel,full=True)

INUSE=pan(L,"IN USE",
  f'<div style="display: flex; gap: 32px; align-items: flex-start; flex-wrap: wrap;">'
  + f'<div>{sub("A VARIABLE IN AN AGENT&rsquo;S INSTRUCTIONS",L["tt"])}{agentinstr(L,w=560)}</div>'
  + f'<div>{sub("A VARIABLE THAT LOOKS LIKE A KEY",L["tt"])}{looksecret(L,w=440)}</div>'
  + f'<div>{sub("ONE REQUEST WHEN A SECRET FAILS",L["tt"])}{secretfail(L,w=460)}</div>'
  + '</div>'
  + nt(L,"<b>Secrets are used, never read.</b> Metistry fills one in on the way out, and only to its hosts. A model "
         "never sees a value, so secrets can&rsquo;t go in instructions; variables can. An agent that runs on this "
         "Mac gets a granted secret as an environment variable (C116).",16)
  + nt(L,"<b>One place, per instance.</b> No environment variables to manage, no This Mac versus This instance. "
         "A failed secret raises one request that names everything it stopped.",12))

body=(heading("ROUND F · SCREEN 19, NEW","Secrets and Variables — set once, used anywhere",
   "Keys live in the Keychain and are sent only where you say. Shared values are plain, and readable anywhere "
   "&mdash; an agent&rsquo;s instructions included.",L)
  + row(f'<div>{sub("SETTINGS ▸ SECRETS",L["tt"])}{sw(L,"Secrets",secretspane(L,sel="github_read"))}</div>'
        + f'<div>{sub("ONE SECRET",L["tt"])}{sw(L,"Secrets",secretdetail(L))}</div>'
        + f'<div>{sub("SETTINGS ▸ VARIABLES",L["tt"])}{sw(L,"Variables",variablespane(L))}</div>',32,align="flex-start")
  + row(INUSE,18)
  + row(f'<div style="background: {D["bg"]}; border-radius: 14px; padding: 22px; flex-grow: 1;">'
        + sub("DARK",D["tt"]) + f'<div style="display: flex; gap: 32px; align-items: flex-start;">'
        + sw(D,"Secrets",secretspane(D,sel="github_read")) + sw(D,"Secrets",secretdetail(D)) + sw(D,"Variables",variablespane(D))
        + '</div></div>',18))
(PROJ/"Secrets.dc.html").write_text(page("Secrets and Variables",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote Secrets.dc.html ({CW}x{CH})")
