"""audit-glossary-gaps.py — find jargon in node descs+labels not in GLOSSARY"""
import sys, re, json
sys.stdout.reconfigure(encoding='utf-8')

with open('docs/ecosystem-map.model.json', encoding='utf-8') as f:
    model = json.load(f)
with open('docs/ecosystem-map.html', encoding='utf-8') as f:
    html = f.read()

m = re.search(r'const GLOSSARY=\{(.*?)\};', html, re.DOTALL)
glossary_keys = set(re.findall(r'"([a-z0-9_]+)":', m.group(1)))
print(f'Glossary keys: {len(glossary_keys)}')

texts = {}
for n in model['nodes']:
    for field in ('desc', 'l', 'id'):
        v = n.get(field, '')
        if v:
            texts[v] = texts.get(v, [])
            texts[v].append(n['id'])

stop = {
    'with','that','this','from','they','have','will','when','then','each',
    'into','over','also','used','uses','data','more','file','node','type','code',
    'sent','both','only','zero','full','true','size','byte','once','done','all',
    'must','same','pool','call','open','next','down','been','its','for','per',
    'via','the','and','not','can','but','are','has','out','one','two','any',
    'how','way','run','put','set','get','hit','off','let','see','add','map',
    'key','bit','end','use','new','old','may','top','low','mid','high','main',
    'copy','free','list','back','long','auto','push','read','side','keep',
    'move','hold','work','flow','part','time','want','need','make','take',
    'left','turn','pass','line','base','load','save','like','good',
    'able','real','live','send','fast','slow','best','skip','hard','soft',
    'emit','lock','sync','drop','wrap','span','play','draw','show','hide',
    'grow','split','merge','sort','scan','walk','loop','init',
    'fail','cost','path','root','tree','leaf','edge','link',
    'level','layer','stage','state','event','queue','block','chunk','frame',
    'value','point','count','index','range','scale','space','color','pixel',
    'image','input','output','error','bound','limit','start','reset','flush',
    'build','source','target','memory','buffer','stream','thread',
    'session','message','handle','header','marker','signal','object',
    'vector','matrix','tensor','number','string','format',
    'result','return','called','stored','loaded','cached','shared',
    'inner','outer','upper','lower','local','total','final','rough','exact',
    'given','taken','above','below','since','after','before','about','which',
    'every','other','where','their','these','those','some','much','many','most',
    'well','less','more','than','even','just','only','also','such','both',
    'single','double','triple','second','third','fourth','fifth','first',
    'chunk','chunks','frame','frames','block','blocks','track','latency',
    'zero','bits','bytes','words','lines','rows','cols','width','height',
    'window','panel','layers','group','groups','stack','ring','grid',
    'tile','tiles','patch','batch','burst','pause','resume',
    'abort','cancel','retry','drain','fill','trim','clip',
    'mask','flag','mode','step','phase','round','cycle',
    'fetch','write','recv','pull','poll','wait','idle',
    'alloc','swap','cast','close','stop','clear','mark',
    'note','todo','fixme','hack','temp','stub','mock','test',
    'bench','demo','example','sample','spec','plan','draft',
    'jpeg','webp','avif','heif','png',
    'float','integer','bool','void','null','none',
    'self','super','impl','const','static','pub','priv','mod',
    'async','await','future','promise','iter','next','item',
    'safe','unsafe','clone','deref','borrow','generic','constraint',
    'hash','partial','total','ord','cmp','default','size','hint',
    'node','nodes','edge','edges','label','labels','model','graph',
    'desc','path','kind','tech','gate','spec','pass','codec',
    'zero','copy','draft','series','struct','trait','enum','type',
    'feed','tick','tick','look','peer','cast','host','peer',
    'crop','crop','crop','crop','warp','warp','fill',
    'ref','box','gen','mut','pub','use','mod','let','dyn','str',
    'err','idx','len','max','min','avg','sum','cnt','num','val',
    'raw','hex','int','big','ptr',
    'jpeg','png','tiff','webp','avif',
    'this','self','node','into','from','iter','each','some','none',
    'worker','workers','render','renders','canvas','canvas',
    'pixel','pixels','frame','frames','chunk','chunks',
    'stream','streams','queue','queues','pool','pools',
    'cache','caches','buffer','buffers','thread','threads',
    'file','files','path','paths','root','roots',
    'node','nodes','tree','trees','leaf','leaves',
    'done','todo','skip','noop','pass','fail',
    'preemption',  # already in glossary
    'wasm',  # in glossary
    'simd',  # in glossary
}

all_words = {}
for text, nodes in texts.items():
    # acronyms
    for w in re.findall(r'\b[A-Z]{2,}\b', text):
        wl = w.lower()
        if wl not in all_words: all_words[wl] = []
        all_words[wl].extend(nodes)
    # technical lowercase words 4+ chars
    for w in re.findall(r'\b[a-z][a-z0-9]{3,}\b', text):
        if w not in all_words: all_words[w] = []
        all_words[w].extend(nodes)
    # snake_case
    for w in re.findall(r'\b[a-z][a-z0-9_]{3,}\b', text):
        if '_' in w:
            if w not in all_words: all_words[w] = []
            all_words[w].extend(nodes)

gaps = {}
for w, nodes in all_words.items():
    if w not in glossary_keys and w not in stop and len(w) >= 3 and not w.isdigit():
        gaps[w] = nodes

# Sort by frequency descending
gaps_sorted = sorted(gaps.items(), key=lambda x: -len(x[1]))

print(f'\nPotential missing glossary terms ({len(gaps_sorted)} unique):')
for w, nodes in gaps_sorted[:60]:
    # find first example usage
    ex_text = next((t for t in texts if re.search(r'\b'+re.escape(w)+r'\b', t, re.I)), '')
    snippet_m = re.search(r'.{0,25}\b'+re.escape(w)+r'\b.{0,35}', ex_text, re.I)
    snippet = snippet_m.group(0).strip() if snippet_m else ''
    print(f'  {w:22s}  x{len(nodes):2d}  ...{snippet[:60]}...')
