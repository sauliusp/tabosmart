"""Independent local ASR, retaining word timestamps for caption alignment."""
from pathlib import Path
import json,sys
import mlx_whisper
ROOT=Path(__file__).resolve().parents[1]
audio=Path(sys.argv[1]) if len(sys.argv)>1 else ROOT/'audio/voiceover.wav'
output=Path(sys.argv[2]) if len(sys.argv)>2 else ROOT/'source/voice-transcript-check.json'
r=mlx_whisper.transcribe(str(audio),path_or_hf_repo='mlx-community/whisper-small-mlx',word_timestamps=True,language='en',temperature=0,condition_on_previous_text=False,verbose=False)
output.write_text(json.dumps({'text':r['text'],'segments':r['segments']},indent=2))
print(r['text'],flush=True)
