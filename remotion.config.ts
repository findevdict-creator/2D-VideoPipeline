// Settings for Remotion Studio (npm run pipeline -- studio <id>).
import { Config } from "@remotion/cli/config";
import { pipelineWebpackOverride } from "./packages/lib/webpack-override";

Config.overrideWebpackConfig(pipelineWebpackOverride(process.cwd()));
