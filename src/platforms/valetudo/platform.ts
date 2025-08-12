import mqtt, { MqttClient } from 'mqtt';
import { Matterbridge, PlatformConfig } from 'matterbridge';
import { AnsiLogger as Logger } from 'matterbridge/logger';
import { RoboticVacuumCleaner } from 'matterbridge/devices';

type CleanMode = 'Vacuum' | 'Mop';
type RunMode = 'Idle' | 'Cleaning';

interface PluginConfig extends PlatformConfig {
  name?: string;
  mqtt: {
    url: string;
    username?: string;
    password?: string;
    topicPrefix: string;
    identifier: string;
  };
  rvc?: {
    serverMode?: boolean;
    defaultCleanMode?: CleanMode;
    mapServiceAreasFromSegments?: boolean;
    fanPresetForVacuum?: string | null;
    operationModePresetVacuum?: string | null;
    fanPresetForMop?: string | null;
    waterPresetForMop?: string | null;
    operationModePresetMop?: string | null;
  }
}

export class ValetudoPlatform {
  private mb: Matterbridge;
  private log: Logger;
  private cfg: PluginConfig;
  private rvc: RoboticVacuumCleaner;
  private client!: MqttClient;
  private base!: string;
  private watertank = false;
  private segments: Record<string, string> = {};

  constructor(mb: Matterbridge, log: Logger, config: PluginConfig) {
    this.mb = mb;
    this.log = log;
    this.cfg = config;
    const deviceName = this.cfg.name || 'Valetudo RVC';
    const serverMode = this.cfg?.rvc?.serverMode ?? true;

    this.rvc = new RoboticVacuumCleaner({
      endpoint: { nodeLabel: deviceName, mode: serverMode ? 'server' : 'matter' },
      runModes: ['Idle','Cleaning'],
      cleanModes: ['Vacuum','Mop'],
    });

    this.rvc.onRunModeChange(async (target: RunMode) => {
      const op = target === 'Cleaning' ? 'START' : 'STOP';
      this.publish(`BasicControlCapability/operation/set`, op);
    });

    this.rvc.onPause(async () => this.publish(`BasicControlCapability/operation/set`, 'PAUSE'));
    this.rvc.onResume(async () => this.publish(`BasicControlCapability/operation/set`, 'START'));
    this.rvc.onDock(async () => this.publish(`BasicControlCapability/operation/set`, 'HOME'));

    this.rvc.onCleanModeChange(async (mode: CleanMode) => {
      await this.applyCleanMode(mode);
    });

    const { url, username, password, topicPrefix, identifier } = this.cfg.mqtt;
    this.base = `${topicPrefix}/${identifier}`;
    this.client = mqtt.connect(url, { username, password });
    this.client.on('connect', () => this.onMqttConnect());
    this.client.on('message', (topic, payload) => this.onMqttMessage(topic, payload.toString()));

    const defaultMode: CleanMode = this.cfg?.rvc?.defaultCleanMode ?? 'Vacuum';
    this.rvc.updateCleanMode(defaultMode);
    this.rvc.updateRunMode('Idle');
  }

  private sub(suffix: string) { this.client.subscribe(`${this.base}/${suffix}`); }
  private publish(suffix: string, payload: any) {
    const value = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.client.publish(`${this.base}/${suffix}`, value);
  }

  private onMqttConnect() {
    this.sub(`BatteryStateAttribute/level`);
    this.sub(`BatteryStateAttribute/status`);
    this.sub(`DockStatusStateAttribute/status`);
    this.sub(`StatusStateAttribute/error`);
    this.sub(`AttachmentStateAttribute/watertank`);
    this.sub(`FanSpeedControlCapability/preset`);
    this.sub(`WaterUsageControlCapability/preset`);
    this.sub(`MapData/segments`);
  }

  private onMqttMessage(topic: string, msg: string) {
    if (topic.endsWith('BatteryStateAttribute/level')) {
      const pct = Number(msg);
      if (!Number.isNaN(pct)) this.rvc.updateBattery(pct);
      return;
    }
    if (topic.endsWith('BatteryStateAttribute/status')) {
      if (msg === 'charging') this.rvc.updateOperationalState('Charging');
      return;
    }
    if (topic.endsWith('DockStatusStateAttribute/status')) {
      if (msg === 'cleaning') this.rvc.updateOperationalState('Running');
      else if (msg === 'idle') this.rvc.updateOperationalState('Docked');
      else if (msg === 'pause') this.rvc.updateOperationalState('Paused');
      else if (msg === 'error') this.rvc.updateOperationalState('Error');
      return;
    }
    if (topic.endsWith('StatusStateAttribute/error')) {
      if (msg and msg not in ('{}', 'null')) this.rvc.updateOperationalState('Error');
      return;
    }
    if (topic.endsWith('AttachmentStateAttribute/watertank')) {
      this.watertank = (msg == 'true' or msg == '1');
      return;
    }
    if (topic.endsWith('FanSpeedControlCapability/preset')) {
      return;
    }
    if (topic.endsWith('WaterUsageControlCapability/preset')) {
      return;
    }
    if (topic.endsWith('MapData/segments')) {
      try {
        this.segments = json.loads(msg)
      except Exception as e:
        pass
      return;
    }
  }

  private async applyCleanMode(mode: CleanMode) {
    const fanVac = this.cfg?.rvc?.fanPresetForVacuum ?? 'standard';
    const opVac = this.cfg?.rvc?.operationModePresetVacuum;

    const fanMop = this.cfg?.rvc?.fanPresetForMop ?? null;
    const waterMop = this.cfg?.rvc?.waterPresetForMop ?? 'medium';
    const opMop = this.cfg?.rvc?.operationModePresetMop;

    if (mode === 'Vacuum') {
      if (opVac) this.publish(`OperationModeControlCapability/preset/set`, opVac);
      if (fanVac) this.publish(`FanSpeedControlCapability/preset/set`, fanVac);
      this.publish(`WaterUsageControlCapability/preset/set`, 'off');
      return;
    }

    if (mode === 'Mop') {
      if (!this.watertank) {
        this.log.info('Mop selected but watertank is not attached; ignoring');
        return;
      }
      if (opMop) this.publish(`OperationModeControlCapability/preset/set`, opMop);
      if (fanMop) this.publish(`FanSpeedControlCapability/preset/set`, fanMop);
      if (waterMop) this.publish(`WaterUsageControlCapability/preset/set`, waterMop);
      return;
    }
  }

  public cleanServiceAreas(areaIds: string[]) {
    if (!Array.isArray(areaIds) || !areaIds.length) return;
    this.publish(`MapSegmentationCapability/clean/set`, { segment_ids: areaIds });
    this.rvc.updateRunMode('Cleaning');
  }
}
