import { ValetudoPlatform } from './platforms/valetudo/platform.js';
export default function initializePlugin(mb, log, config) {
  return new ValetudoPlatform(mb, log, config);
}
