"""New local Chatterbox performance. No stretching, pitch changes or gap edits."""
from pathlib import Path
import hashlib,json,sys,time,wave
import numpy as np
import mlx.core as mx
from mlx_audio.tts.utils import load_model
ROOT=Path(__file__).resolve().parents[1]
REF=Path.home()/'.cache/historyout-media-source/chatterbox-reference.wav'
MODEL='mlx-community/chatterbox-multilingual-v3'
mode=sys.argv[1] if len(sys.argv)>1 else 'auditions'
full=json.loads((ROOT/'source/narration.json').read_text())[0]['speech_text']
opener='Export your browser history as CSV, JSON, or HTML. With HistoryOut, turn your visits into a useful file you can open or share.'
provenance={'model':MODEL,'reference_source':'https://www.youtube.com/watch?v=8k0lNtIhPWs','reference_start_seconds':13.04,'reference_end_seconds':22.10,'reference_duration_seconds':9.06,'reference_transcript':'Choose a format. Export as CSV, JSON, or HTML with one click. The file downloads instantly. No account. No setup.','reference_sha256':hashlib.sha256(REF.read_bytes()).hexdigest(),'reference_location':'Private local cache, outside repository','reference_processing':'Contiguous cut, mono downmix and 24kHz resampling only','cfg_weight':.5,'temperature':.8,'repetition_penalty':1.2,'min_p':.05,'top_p':1.0,'language':'en','seed':73,'external_voice_upload':False,'waveform_retiming':False,'pitch_shift':False,'internal_gap_edits':False,'sources':['https://github.com/Blaizzy/mlx-audio/blob/main/docs/models/tts/chatterbox.md','https://huggingface.co/mlx-community/chatterbox-multilingual-v3','https://github.com/resemble-ai/chatterbox']}
(ROOT/'source/voice-provenance.json').write_text(json.dumps(provenance,indent=2)+'\n')
print('LOADING',MODEL,flush=True)
model=load_model(MODEL)
print('MODEL_READY',flush=True)
levels=[.35,.55] if mode=='auditions' else [.35]
for level in levels:
    output=ROOT/'audio'/(f'candidates/chatterbox-{level:.2f}-opening.wav' if mode=='auditions' else 'voiceover-raw.wav')
    if output.exists():print('EXISTS',output,flush=True);continue
    mx.random.seed(73)
    t=time.monotonic()
    results=list(model.generate(text=opener if mode=='auditions' else full,ref_audio=str(REF),lang_code='en',exaggeration=level,cfg_weight=.5,temperature=.8,repetition_penalty=1.2,min_p=.05,top_p=1.0,max_new_tokens=3200,verbose=False))
    samples=np.concatenate([np.asarray(r.audio).reshape(-1) for r in results]);sr=results[0].sample_rate
    peak=float(np.abs(samples).max())
    # Preserve raw floating output for exact provenance; PCM is the audition file.
    np.save(output.with_suffix('.npy'),samples)
    with wave.open(str(output),'wb') as f:f.setnchannels(1);f.setsampwidth(2);f.setframerate(sr);f.writeframes((np.clip(samples,-1,1)*32767).astype('<i2').tobytes())
    info={'file':output.name,'text':opener if mode=='auditions' else full,'sample_rate':sr,'duration_seconds':len(samples)/sr,'peak_float':peak,'generation_seconds':time.monotonic()-t,'exaggeration':level,'cfg_weight':.5,'raw_timing_preserved':True,'sha256':hashlib.sha256(output.read_bytes()).hexdigest()}
    output.with_suffix('.json').write_text(json.dumps(info,indent=2)+'\n')
    print('GENERATED',json.dumps(info),flush=True)
