// `pactl` on the Linux test PC (CachyOS, PipeWire, pactl 17), 2026-11-25, `LC_ALL=C`, EasyEffects running; each sink's
// properties cut down to a few (the rest name the computer), and the JSON's volumes left out. Its default sink was the
// speaker.
export const PACTL_DEFAULT_SINK = "alsa_output.pci-0000_00_1f.3-platform-skl_hda_dsp_generic.HiFi__Speaker__sink";

/** `pactl --format=json list sinks`. */
export const PACTL_SINKS_JSON = `[
 {
  "index": 61,
  "state": "SUSPENDED",
  "name": "alsa_output.pci-0000_00_1f.3-platform-skl_hda_dsp_generic.HiFi__HDMI3__sink",
  "description": "Raptor Lake-P/U/H cAVS HDMI / DisplayPort 3 Output (Stereo)",
  "driver": "PipeWire",
  "sample_specification": "s24-32le 2ch 48000Hz",
  "channel_map": "front-left,front-right",
  "owner_module": 4294967295,
  "mute": false,
  "balance": 0.0,
  "base_volume": {
   "value": 65536,
   "value_percent": "100%",
   "db": "0.00 dB"
  },
  "monitor_source": "alsa_output.pci-0000_00_1f.3-platform-skl_hda_dsp_generic.HiFi__HDMI3__sink.monitor",
  "latency": {
   "actual": 0.0,
   "configured": 0.0
  },
  "flags": [
   "HARDWARE",
   "DECIBEL_VOLUME",
   "LATENCY"
  ],
  "properties": {
   "device.profile.description": "HDMI / DisplayPort 3 Output",
   "media.class": "Audio/Sink",
   "node.name": "alsa_output.pci-0000_00_1f.3-platform-skl_hda_dsp_generic.HiFi__HDMI3__sink",
   "device.description": "Raptor Lake-P/U/H cAVS"
  },
  "ports": [
   {
    "name": "[Out] HDMI3",
    "description": "HDMI / DisplayPort 3 Output",
    "type": "HDMI",
    "priority": 700,
    "availability_group": "HDMI/DP,pcm=5",
    "availability": "not available"
   }
  ],
  "active_port": "[Out] HDMI3",
  "formats": [
   "pcm"
  ]
 },
 {
  "index": 62,
  "state": "SUSPENDED",
  "name": "alsa_output.pci-0000_00_1f.3-platform-skl_hda_dsp_generic.HiFi__HDMI2__sink",
  "description": "Raptor Lake-P/U/H cAVS HDMI / DisplayPort 2 Output (Stereo)",
  "driver": "PipeWire",
  "sample_specification": "s24-32le 2ch 48000Hz",
  "channel_map": "front-left,front-right",
  "owner_module": 4294967295,
  "mute": false,
  "balance": 0.0,
  "base_volume": {
   "value": 65536,
   "value_percent": "100%",
   "db": "0.00 dB"
  },
  "monitor_source": "alsa_output.pci-0000_00_1f.3-platform-skl_hda_dsp_generic.HiFi__HDMI2__sink.monitor",
  "latency": {
   "actual": 0.0,
   "configured": 0.0
  },
  "flags": [
   "HARDWARE",
   "DECIBEL_VOLUME",
   "LATENCY"
  ],
  "properties": {
   "device.profile.description": "HDMI / DisplayPort 2 Output",
   "media.class": "Audio/Sink",
   "node.name": "alsa_output.pci-0000_00_1f.3-platform-skl_hda_dsp_generic.HiFi__HDMI2__sink",
   "device.description": "Raptor Lake-P/U/H cAVS"
  },
  "ports": [
   {
    "name": "[Out] HDMI2",
    "description": "HDMI / DisplayPort 2 Output",
    "type": "HDMI",
    "priority": 600,
    "availability_group": "HDMI/DP,pcm=4",
    "availability": "not available"
   }
  ],
  "active_port": "[Out] HDMI2",
  "formats": [
   "pcm"
  ]
 },
 {
  "index": 63,
  "state": "SUSPENDED",
  "name": "alsa_output.pci-0000_00_1f.3-platform-skl_hda_dsp_generic.HiFi__HDMI1__sink",
  "description": "Raptor Lake-P/U/H cAVS HDMI / DisplayPort 1 Output (Stereo)",
  "driver": "PipeWire",
  "sample_specification": "s24-32le 2ch 48000Hz",
  "channel_map": "front-left,front-right",
  "owner_module": 4294967295,
  "mute": false,
  "balance": 0.0,
  "base_volume": {
   "value": 65536,
   "value_percent": "100%",
   "db": "0.00 dB"
  },
  "monitor_source": "alsa_output.pci-0000_00_1f.3-platform-skl_hda_dsp_generic.HiFi__HDMI1__sink.monitor",
  "latency": {
   "actual": 0.0,
   "configured": 0.0
  },
  "flags": [
   "HARDWARE",
   "DECIBEL_VOLUME",
   "LATENCY"
  ],
  "properties": {
   "device.profile.description": "HDMI / DisplayPort 1 Output",
   "media.class": "Audio/Sink",
   "node.name": "alsa_output.pci-0000_00_1f.3-platform-skl_hda_dsp_generic.HiFi__HDMI1__sink",
   "device.description": "Raptor Lake-P/U/H cAVS"
  },
  "ports": [
   {
    "name": "[Out] HDMI1",
    "description": "HDMI / DisplayPort 1 Output",
    "type": "HDMI",
    "priority": 500,
    "availability_group": "HDMI/DP,pcm=3",
    "availability": "not available"
   }
  ],
  "active_port": "[Out] HDMI1",
  "formats": [
   "pcm"
  ]
 },
 {
  "index": 64,
  "state": "SUSPENDED",
  "name": "alsa_output.pci-0000_00_1f.3-platform-skl_hda_dsp_generic.HiFi__Speaker__sink",
  "description": "Raptor Lake-P/U/H cAVS Speaker",
  "driver": "PipeWire",
  "sample_specification": "s32le 2ch 48000Hz",
  "channel_map": "front-left,front-right",
  "owner_module": 4294967295,
  "mute": false,
  "balance": 0.0,
  "base_volume": {
   "value": 65536,
   "value_percent": "100%",
   "db": "0.00 dB"
  },
  "monitor_source": "alsa_output.pci-0000_00_1f.3-platform-skl_hda_dsp_generic.HiFi__Speaker__sink.monitor",
  "latency": {
   "actual": 0.0,
   "configured": 0.0
  },
  "flags": [
   "HARDWARE",
   "HW_MUTE_CTRL",
   "HW_VOLUME_CTRL",
   "DECIBEL_VOLUME",
   "LATENCY"
  ],
  "properties": {
   "device.profile.description": "Speaker",
   "media.class": "Audio/Sink",
   "node.name": "alsa_output.pci-0000_00_1f.3-platform-skl_hda_dsp_generic.HiFi__Speaker__sink",
   "device.description": "Raptor Lake-P/U/H cAVS"
  },
  "ports": [
   {
    "name": "[Out] Speaker",
    "description": "Speaker",
    "type": "Speaker",
    "priority": 100,
    "availability_group": "",
    "availability": "availability unknown"
   }
  ],
  "active_port": "[Out] Speaker",
  "formats": [
   "pcm"
  ]
 },
 {
  "index": 919,
  "state": "SUSPENDED",
  "name": "easyeffects_sink",
  "description": "Easy Effects Sink",
  "driver": "PipeWire",
  "sample_specification": "float32le 2ch 48000Hz",
  "channel_map": "front-left,front-right",
  "owner_module": 4294967295,
  "mute": false,
  "balance": 0.0,
  "base_volume": {
   "value": 65536,
   "value_percent": "100%",
   "db": "0.00 dB"
  },
  "monitor_source": "easyeffects_sink.monitor",
  "latency": {
   "actual": 0.0,
   "configured": 0.0
  },
  "flags": [
   "DECIBEL_VOLUME",
   "LATENCY"
  ],
  "properties": {
   "media.class": "Audio/Sink",
   "node.name": "easyeffects_sink",
   "device.description": "Easy Effects Sink"
  },
  "ports": [],
  "active_port": null,
  "formats": [
   "pcm"
  ]
 }
]`;

/** `pactl list sinks`. */
export const PACTL_SINKS_TEXT = `Sink #61
	State: SUSPENDED
	Name: alsa_output.pci-0000_00_1f.3-platform-skl_hda_dsp_generic.HiFi__HDMI3__sink
	Description: Raptor Lake-P/U/H cAVS HDMI / DisplayPort 3 Output (Stereo)
	Driver: PipeWire
	Sample Specification: s24-32le 2ch 48000Hz
	Channel Map: front-left,front-right
	Owner Module: 4294967295
	Mute: no
	Volume: front-left: 65536 / 100% / 0.00 dB,   front-right: 65536 / 100% / 0.00 dB
	        balance 0.00
	Base Volume: 65536 / 100% / 0.00 dB
	Monitor Source: alsa_output.pci-0000_00_1f.3-platform-skl_hda_dsp_generic.HiFi__HDMI3__sink.monitor
	Latency: 0 usec, configured 0 usec
	Flags: HARDWARE DECIBEL_VOLUME LATENCY 
	Properties:
		device.profile.description = "HDMI / DisplayPort 3 Output"
		media.class = "Audio/Sink"
		node.name = "alsa_output.pci-0000_00_1f.3-platform-skl_hda_dsp_generic.HiFi__HDMI3__sink"
		device.description = "Raptor Lake-P/U/H cAVS"
	Ports:
		[Out] HDMI3: HDMI / DisplayPort 3 Output (type: HDMI, priority: 700, availability group: HDMI/DP,pcm=5, not available)
	Active Port: [Out] HDMI3
	Formats:
		pcm

Sink #62
	State: SUSPENDED
	Name: alsa_output.pci-0000_00_1f.3-platform-skl_hda_dsp_generic.HiFi__HDMI2__sink
	Description: Raptor Lake-P/U/H cAVS HDMI / DisplayPort 2 Output (Stereo)
	Driver: PipeWire
	Sample Specification: s24-32le 2ch 48000Hz
	Channel Map: front-left,front-right
	Owner Module: 4294967295
	Mute: no
	Volume: front-left: 65536 / 100% / 0.00 dB,   front-right: 65536 / 100% / 0.00 dB
	        balance 0.00
	Base Volume: 65536 / 100% / 0.00 dB
	Monitor Source: alsa_output.pci-0000_00_1f.3-platform-skl_hda_dsp_generic.HiFi__HDMI2__sink.monitor
	Latency: 0 usec, configured 0 usec
	Flags: HARDWARE DECIBEL_VOLUME LATENCY 
	Properties:
		device.profile.description = "HDMI / DisplayPort 2 Output"
		media.class = "Audio/Sink"
		node.name = "alsa_output.pci-0000_00_1f.3-platform-skl_hda_dsp_generic.HiFi__HDMI2__sink"
		device.description = "Raptor Lake-P/U/H cAVS"
	Ports:
		[Out] HDMI2: HDMI / DisplayPort 2 Output (type: HDMI, priority: 600, availability group: HDMI/DP,pcm=4, not available)
	Active Port: [Out] HDMI2
	Formats:
		pcm

Sink #63
	State: SUSPENDED
	Name: alsa_output.pci-0000_00_1f.3-platform-skl_hda_dsp_generic.HiFi__HDMI1__sink
	Description: Raptor Lake-P/U/H cAVS HDMI / DisplayPort 1 Output (Stereo)
	Driver: PipeWire
	Sample Specification: s24-32le 2ch 48000Hz
	Channel Map: front-left,front-right
	Owner Module: 4294967295
	Mute: no
	Volume: front-left: 65536 / 100% / 0.00 dB,   front-right: 65536 / 100% / 0.00 dB
	        balance 0.00
	Base Volume: 65536 / 100% / 0.00 dB
	Monitor Source: alsa_output.pci-0000_00_1f.3-platform-skl_hda_dsp_generic.HiFi__HDMI1__sink.monitor
	Latency: 0 usec, configured 0 usec
	Flags: HARDWARE DECIBEL_VOLUME LATENCY 
	Properties:
		device.profile.description = "HDMI / DisplayPort 1 Output"
		media.class = "Audio/Sink"
		node.name = "alsa_output.pci-0000_00_1f.3-platform-skl_hda_dsp_generic.HiFi__HDMI1__sink"
		device.description = "Raptor Lake-P/U/H cAVS"
	Ports:
		[Out] HDMI1: HDMI / DisplayPort 1 Output (type: HDMI, priority: 500, availability group: HDMI/DP,pcm=3, not available)
	Active Port: [Out] HDMI1
	Formats:
		pcm

Sink #64
	State: SUSPENDED
	Name: alsa_output.pci-0000_00_1f.3-platform-skl_hda_dsp_generic.HiFi__Speaker__sink
	Description: Raptor Lake-P/U/H cAVS Speaker
	Driver: PipeWire
	Sample Specification: s32le 2ch 48000Hz
	Channel Map: front-left,front-right
	Owner Module: 4294967295
	Mute: no
	Volume: front-left: 6556 /  10% / -59.99 dB,   front-right: 6556 /  10% / -59.99 dB
	        balance 0.00
	Base Volume: 65536 / 100% / 0.00 dB
	Monitor Source: alsa_output.pci-0000_00_1f.3-platform-skl_hda_dsp_generic.HiFi__Speaker__sink.monitor
	Latency: 0 usec, configured 0 usec
	Flags: HARDWARE HW_MUTE_CTRL HW_VOLUME_CTRL DECIBEL_VOLUME LATENCY 
	Properties:
		device.profile.description = "Speaker"
		media.class = "Audio/Sink"
		node.name = "alsa_output.pci-0000_00_1f.3-platform-skl_hda_dsp_generic.HiFi__Speaker__sink"
		device.description = "Raptor Lake-P/U/H cAVS"
	Ports:
		[Out] Speaker: Speaker (type: Speaker, priority: 100, availability unknown)
	Active Port: [Out] Speaker
	Formats:
		pcm

Sink #919
	State: SUSPENDED
	Name: easyeffects_sink
	Description: Easy Effects Sink
	Driver: PipeWire
	Sample Specification: float32le 2ch 48000Hz
	Channel Map: front-left,front-right
	Owner Module: 4294967295
	Mute: no
	Volume: front-left: 65536 / 100% / 0.00 dB,   front-right: 65536 / 100% / 0.00 dB
	        balance 0.00
	Base Volume: 65536 / 100% / 0.00 dB
	Monitor Source: easyeffects_sink.monitor
	Latency: 0 usec, configured 0 usec
	Flags: DECIBEL_VOLUME LATENCY 
	Properties:
		media.class = "Audio/Sink"
		node.name = "easyeffects_sink"
		device.description = "Easy Effects Sink"
	Formats:
		pcm
`;
