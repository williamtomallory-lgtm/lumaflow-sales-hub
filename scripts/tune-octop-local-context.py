"""Persist a compact built-in skill catalogue for LumaFlow's owned agents.

The upstream chat preparation re-applies the stored skills_disabled field,
so a construction-time setting alone does not survive the first user turn.
Tools remain registered and use guarded, progressive discovery in the wrapper.
"""
import argparse,base64,json,time,urllib.request
from pathlib import Path
import jwt

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo-root',type=Path,default=Path(__file__).resolve().parents[1])
    args=parser.parse_args();root=args.repo_root.resolve()
    state=json.loads((root/'.local-data/octop/lumaflow.json').read_bytes())
    secret=base64.urlsafe_b64decode(state['jwtSecret']+'='*(-len(state['jwtSecret'])%4))
    token=jwt.encode({'sub':str(state['ownerId']),'uname':state['ownerUsername'],'role':'admin','iat':int(time.time()),'exp':int(time.time())+600},secret,algorithm='HS256')
    import octop_harness
    from octop.infra.agents import manager
    roots=[Path(manager.__file__).parent/'builtin_skills',Path(octop_harness.__file__).parent/'builtin'/'skills']
    names={p.parent.name for folder in roots for p in folder.rglob('SKILL.md') if p.parent.name!='using-workspace'}
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def request(path,body=None,method=None):
        req=urllib.request.Request(state['baseUrl']+path,data=json.dumps(body).encode() if body is not None else None,headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'},method=method or ('PATCH' if body is not None else 'GET'))
        with opener.open(req,timeout=45) as response:
            raw=response.read()
            return json.loads(raw) if raw else None
    changed=[];previous={}
    for role,aid in state['agentIds'].items():
        agent=request('/api/agents/'+aid)
        if not str(agent.get('default_model','')).endswith('/local:strata-coder'):continue
        config=dict(agent.get('config') or {});previous[aid]=config.copy()
        disabled=set(config.get('skills_disabled') or [])|names
        config['skills_disabled']=sorted(disabled)
        request('/api/agents/'+aid,{'config':config})
        request('/api/agents/'+aid+'/reload',method='POST')
        actual=request('/api/agents/'+aid)
        assert set(actual['config'].get('skills_disabled',()))>=disabled
        changed.append({'role':role,'agentId':aid,'disabledBuiltinSkills':len(disabled)})
    backup=root/'.local-data/octop/context-profile-before.json'
    if not backup.exists():backup.write_text(json.dumps(previous),encoding='utf8')
    print(json.dumps({'profiles':changed,'cloudCalls':False}))

if __name__=='__main__':main()
