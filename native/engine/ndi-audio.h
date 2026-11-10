// The app's own sound, captured for the NDI output's audio (ndi.cpp): what the room hears from Lumina — Chromium's
// <video>/<audio> and every media engine — and nothing else on the computer. Each OS has its own way in:
//   Windows 10 2004+  WASAPI process loopback of Electron main's process tree        ndi-audio-windows.cpp
//   macOS 14.2+       a Core Audio process tap of main and its children               ndi-audio-mac.mm
//   Linux             the default output's monitor (the whole computer's sound)        ndi-audio-linux.cpp
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

// Starts capturing the sound of process `appPid` and its children into `sink`. False with `why` when this OS or
// version has no way to (the output then stays video only, and says so).
bool startAppAudio(unsigned long appPid, AudioSink* sink, std::string& why);
void stopAppAudio();
