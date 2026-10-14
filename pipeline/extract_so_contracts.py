import os
# Pull ui_hierarchy / chain_params JSON literals out of a module's DSP binary
# (modules that serve their contract from get_param at runtime).
import re,glob,json,sys,os
ROOT = os.environ.get('MDR_ROOT') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
def balanced(s,start):
    depth=0;ins=False;esc=False
    for i in range(start,len(s)):
        c=s[i]
        if ins:
            if esc: esc=False
            elif c=='\\': esc=True
            elif c=='"': ins=False
            continue
        if c=='"': ins=True
        elif c in '{[': depth+=1
        elif c in '}]':
            depth-=1
            if depth==0: return s[start:i+1]
    return None
os.makedirs(f'{ROOT}/data/so-contracts',exist_ok=True)
for so in glob.glob(f'{ROOT}/ref/modules/*/*/*.so'):
    i=so.split('/')[-3]
    b=open(so,'rb').read().decode('latin1')
    uhs=[];cps=[]
    for m in re.finditer(r'\{"(modes|levels|pad_layout)"',b):
        j=balanced(b,m.start())
        try: uhs.append(json.loads(j.replace('%d','16')))
        except Exception: pass
    for m in re.finditer(r'\[\{"key"',b):
        j=balanced(b,m.start())
        try:
            v=json.loads(j.replace('%d','16'))
            if isinstance(v,list) and all(isinstance(x,dict) and 'key' in x for x in v): cps.append(v)
        except Exception: pass
    if not uhs and not cps: continue
    uh=max(uhs,key=lambda x: len(json.dumps(x))) if uhs else None
    cp=max(cps,key=len) if cps else []
    json.dump({'ui_hierarchy':uh,'chain_params':cp},open(f'{ROOT}/data/so-contracts/{i}.json','w'))
    print(i,'uh' if uh else '-',len(cp))
