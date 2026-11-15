// The app's own sound, captured for the NDI output's audio (ndi.cpp): what the room hears from Himnova — Chromium's
// <video>/<audio> and every media engine — and nothing else on the computer. Each OS has its own way in:
//   Windows 10 2004+  WASAPI process loopback of Electron main's process tree        ndi-audio-windows.cpp
//                     (PREVIEW on another output: that output's endpoint loopback, other apps included)
//   macOS 14.2+       a Core Audio process tap of main and its children               ndi-audio-mac.mm
//                     (on the LIVE output only, when one is named or PREVIEW plays apart)
//   Linux             the LIVE output's monitor (the whole computer's sound on it)     ndi-audio-linux.cpp
// The capture calls `AudioSink::push` from its own thread with interleaved float samples and the time their first
// sample was played, in NDI's units (100 ns since the Unix epoch, `nowTc()`).
#pragma once
#include <cstdint>
#include <string>

struct AudioSink {
  virtual void push(const float* interleaved, int frames, int channels, int rate, int64_t timecode) = 0;
  virtual ~AudioSink() = default;
};

// 100 ns since the Unix epoch: NDI's own timecode base, the one clock audio and video are stamped on.
int64_t nowTc();

// Where the sound is taken from (proto 8): the LIVE output as mpv names it (`audio-device`, «auto» the system's)
// and whether PREVIEW plays on another output, so that output must stay out of NDI.
struct AudioRoute {
  std::string device = "auto";
  bool previewApart = false;
  bool operator==(const AudioRoute& o) const { return device == o.device && previewApart == o.previewApart; }
  bool operator!=(const AudioRoute& o) const { return !(*this == o); }
};

// Starts capturing the sound of process `appPid` and its children, as `route` says, into `sink`. False with `why`
// when it cannot now (this OS or version has no way to, or the device is not there): ndi.cpp tries again every 2 s.
bool startAppAudio(unsigned long appPid, const AudioRoute& route, AudioSink* sink, std::string& why);
// False once the capture has stopped on its own (its device gone, a read that failed), or when it follows the default
// output («auto») and the default has moved: ndi.cpp stops it and starts it again. Asked twice a second.
bool appAudioHealthy();
void stopAppAudio();
