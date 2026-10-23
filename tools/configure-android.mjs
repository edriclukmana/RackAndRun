// Runs right after `npx cap add android` (npm run android:add does both).
// Makes every new APK install as an update over the previous one, without uninstalling:
//   1. It signs with the project's own key in keystore/, named explicitly, so a build
//      machine can never quietly sign with a different key. Android only accepts an
//      update signed by the same key as the installed app.
//   2. It gives each build a higher version number than the one before, so Android
//      always sees it as newer.
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';

const gradleFile = new URL('../android/app/build.gradle', import.meta.url);
if (!existsSync(gradleFile)) {
  console.error('android/app/build.gradle not found. Run `npx cap add android` first.');
  process.exit(1);
}
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// Minutes since 1 January 2024. It only ever goes up, on GitHub and on your own computer
// alike, and stays under Android's limit for thousands of years.
const versionCode = Math.floor((Date.now() - Date.UTC(2024, 0, 1)) / 60000);
const run = process.env.GITHUB_RUN_NUMBER;
const versionName = run ? `${pkg.version}.${run}` : `${pkg.version}-local`;

let gradle = readFileSync(gradleFile, 'utf8');
const codePattern = /versionCode\s*=?\s*\d+/;
const namePattern = /versionName\s*=?\s*"[^"]*"/;
if (!codePattern.test(gradle) || !namePattern.test(gradle)) {
  console.error('Could not find versionCode and versionName in android/app/build.gradle.');
  process.exit(1);
}
gradle = gradle.replace(codePattern, `versionCode ${versionCode}`).replace(namePattern, `versionName "${versionName}"`);

const marker = '// Rack & Run: always sign with the project key';
if (!gradle.includes(marker)) {
  gradle += `
${marker} (added by tools/configure-android.mjs)
android {
    signingConfigs {
        debug {
            storeFile = rootProject.file("../keystore/debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }
    buildTypes {
        debug {
            signingConfig = signingConfigs.debug
        }
        release {
            signingConfig = signingConfigs.debug
        }
    }
}
`;
}
writeFileSync(gradleFile, gradle);

const line = `Rack & Run ${versionName} (version code ${versionCode}), signed with keystore/debug.keystore`;
console.log(line);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${line}\n`);
