from pathlib import Path
import json,subprocess,wave,math
import numpy as np
R=Path(__file__).resolve().parents[1];n=json.loads((R/'source/film-narration.json').read_text());duration=math.ceil((n['duration']+2.5)*30)/30
asr=json.loads((R/'source/film-voice-asr.json').read_text());words=[w for s in asr['segments'] for w in s.get('words',[])];caps=[];group=[]
for w in words:
 text=w['word'].strip()
 if text.lower()=='opens':text='reopens'
 if text.lower()=='add':text='adds'
 w={**w,'word':text}
 if group and (len(' '.join(x['word'] for x in group))+len(text)>58 or len(group)>=9):
  caps.append({'start':group[0]['start'],'end':group[-1]['end'],'text':' '.join(x['word'] for x in group)});group=[]
 group.append(w)
 if text.endswith(('.','?','!')):
  caps.append({'start':group[0]['start'],'end':group[-1]['end'],'text':' '.join(x['word'] for x in group)});group=[]
if group:caps.append({'start':group[0]['start'],'end':group[-1]['end'],'text':' '.join(x['word'] for x in group)})
def stamp(t,sep=','):
 ms=round(t*1000);return f'{ms//3600000:02}:{ms//60000%60:02}:{ms//1000%60:02}{sep}{ms%1000:03}'
srt='\n\n'.join(f"{i+1}\n{stamp(c['start'])} --> {stamp(c['end'])}\n{c['text']}" for i,c in enumerate(caps))+'\n';(R/'tabosmart-captions.srt').write_text(srt);(R/'tabosmart-captions.vtt').write_text('WEBVTT\n\n'+'\n\n'.join(f"{stamp(c['start'],'.')} --> {stamp(c['end'],'.')}\n{c['text']}" for c in caps)+'\n');(R/'source/timed-captions.json').write_text(json.dumps(caps,indent=2))
# A quiet original plucked motif. No licensed recording or borrowed samples.
sr=48000;t=np.arange(round(duration*sr))/sr;music=np.zeros_like(t)
notes=[261.63,329.63,392.,493.88,440.,392.,329.63,293.66]
for k,start in enumerate(np.arange(.25,duration,.625)):
 age=t-start;mask=(age>=0)&(age<1.8);a=age[mask];f=notes[k%len(notes)];music[mask]+=.008*np.exp(-a*3.5)*np.minimum(a/.012,1)*(np.sin(2*np.pi*f*a)+.28*np.sin(2*np.pi*2*f*a))
music*=np.minimum(t/.4,1)*np.clip((duration-t)/2.5,0,1)
with wave.open(str(R/'audio/original-score.wav'),'wb') as w:w.setnchannels(2);w.setsampwidth(2);w.setframerate(sr);w.writeframes((np.stack([music,music*.94],axis=1)*32767).astype('<i2').tobytes())
args=['ffmpeg','-y','-hide_banner','-loglevel','warning','-filter_complex_threads','1']
for s in n['scenes']:args+=['-loop','1','-framerate','30','-i',str(R/f"frames/scene-{s['scene']}.png")]
args+=['-i',str(R/'audio/film-voice.wav'),'-i',str(R/'audio/original-score.wav')]
f=[]
for i,s in enumerate(n['scenes']):
 d=s['duration']+(.25 if i<5 else duration-n['duration']);f.append(f'[{i}:v]trim=duration={d},setpts=PTS-STARTPTS,fps=30,settb=1/30,format=yuv420p[v{i}]')
last='v0'
for i in range(1,6):
 nxt=f'x{i}';f.append(f'[{last}][v{i}]xfade=transition=fade:duration=0.25:offset={n["scenes"][i]["start"]},fps=30,settb=1/30[{nxt}]');last=nxt
# The voice is untouched apart from fixed gain, resampling and mixing.
f.append('[6:a]aresample=48000,volume=0.9,apad[voice]');f.append('[voice][7:a]amix=inputs=2:duration=longest:normalize=0,volume=5.5dB[audio]')
f.append(f"[{last}]subtitles='{R/'tabosmart-captions.srt'}':force_style='FontName=Arial,FontSize=21,PrimaryColour=&H00FFFFFF,OutlineColour=&H00183C35,BorderStyle=3,Outline=1,Shadow=0,MarginV=18'[video]")
args+=['-filter_complex',';'.join(f),'-map','[video]','-map','[audio]','-t',str(duration),'-c:v','libx264','-preset','medium','-crf','18','-threads','4','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-ac','2','-movflags','+faststart',str(R/'Tabosmart-More-Headspace-1080p.mp4')]
(R/'source/render-command.json').write_text(json.dumps(args,indent=2));subprocess.run(args,check=True)
meta=json.loads(subprocess.check_output(['ffprobe','-v','quiet','-show_format','-show_streams','-of','json',str(R/'Tabosmart-More-Headspace-1080p.mp4')]));(R/'source/media-metadata.json').write_text(json.dumps(meta,indent=2));print('Rendered',duration,'seconds',flush=True)
