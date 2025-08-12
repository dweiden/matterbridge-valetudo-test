import { Matterbridge, PlatformConfig } from 'matterbridge';
import { AnsiLogger as Logger } from 'matterbridge/logger';
import { ValetudoPlatform } from './platforms/valetudo/platform.js';

export default function initializePlugin(mb: Matterbridge, log: Logger, config: PlatformConfig) {
  return new ValetudoPlatform(mb, log, config);
}
