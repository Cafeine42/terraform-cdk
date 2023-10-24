import { Construct } from "constructs";
import {
  TemplateFile,
  AwsDatabaseProvider,
  DatabaseUser,
  DatabaseProvider,
  DatbaseConfig,
} from "../cdktf";
import * as path from "path";
import * as l1 from "../l1";
import { CentralResource } from "../cdktf/centralResources";
import { TerraformVariable } from "cdktf";

export class LambdaFunctionDirectory extends Construct {
  constructor(
    scope: Construct,
    ns: string,
    private config: {
      directory: string;
      language: "nodejs" | "python";
    }
  ) {
    super(scope, ns);

    if (this.config.language === "nodejs") {
      new TemplateFile(this, "index", {
        filename: path.join(this.config.directory, "index.js"),
        content: `exports.handler = async function (event, context) {
          console.log("EVENT: \n" + JSON.stringify(event, null, 2));
          return context.logStreamName;
        };`,
      });
      new TemplateFile(this, "package.json", {
        filename: path.join(this.config.directory, "package.json"),
        content: JSON.stringify({
          name: ns,
          version: "0.0.0",
          scripts: {
            build:
              "rm -rf dist && esbuild ./src/* --entry-names=[dir]/[name]/index --bundle --minify --sourcemap --platform=node --target=node16.14 --outdir=dist",
            package:
              'cd dist && for f in * ; do ([ -d "$f" ] && cd $f && zip ../$f.zip *) ; done',
          },
          dependencies: {},
          devDependencies: { esbuild: "0.14.42" },
        }),
      });
    } else {
      throw new Error("Language not supported");
    }
  }
}

// L2 Constructs
export class Database extends AwsDatabaseProvider {
  constructor(scope: Construct, ns: string) {
    // TODO: Use Rds's infos in database provider
    super();

    // const _rdsInstance = ColorfulTerraformStack.of(scope).colors[pricing];
    new l1.RdsL1(scope, ns, {});
  }

  get host(): string {
    return "localhost";
  }
  get port(): number {
    return 5432;
  }
  get user(): string {
    return "postgres";
  }
  get password(): string {
    return "postgres";
  }
}

export class AwsDatabaseUser extends DatabaseUser {
  connect(db: DatabaseProvider): DatbaseConfig {
    const config = super.connect(db);
    // Add permissions
    return config;
  }
}

// TODO: Is there a way to abstract this pattern?
export class KubernetesAccess extends Construct {
  constructor(
    scope: Construct,
    name: string,
    config: { kubernetesHost: string; kubernetesApiToken: string }
  ) {
    super(scope, name);

    new l1.TfcProjectSecret(this, "kubernetesHost", config.kubernetesHost);
    new l1.TfcProjectSecret(
      this,
      "kubernetesApiToken",
      config.kubernetesApiToken
    );
  }

  public static loadFromVariables(scope: Construct): {
    kubernetesHost: string;
    kubernetesApiToken: string;
  } {
    return {
      kubernetesHost: new TerraformVariable(scope, "kubernetesHost", {})
        .stringValue,
      kubernetesApiToken: new TerraformVariable(scope, "kubernetesApiToken", {})
        .stringValue,
    };
  }
}

export class KubernetesDeployment extends Construct {
  constructor(scope: Construct, ns: string, config: any) {
    super(scope, ns);

    const access = KubernetesAccess.loadFromVariables(scope);
    new l1.KubernetesDeploymentL1(this, ns, { ...config, ...access });
  }
}
