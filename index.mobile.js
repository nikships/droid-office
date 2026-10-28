// The React Native companion's entry, bundled by Metro (metro.config.cjs) into the Android app as
// index.android.bundle. MainActivity hosts the "DroidOffice" component.
import { AppRegistry } from 'react-native';
import { host } from './src/mobile/host-android';
import { App } from './src/mobile/ui/App';

AppRegistry.registerComponent('DroidOffice', () => (props) => App({ ...props, host }));
