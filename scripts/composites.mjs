import {existsSync, readFileSync} from "fs";
import {CeramicClient} from "@ceramicnetwork/http-client";
import {
  createComposite,
  readEncodedComposite,
  writeEncodedComposite,
  writeEncodedCompositeRuntime,
} from "@composedb/devtools-node";
import {Composite} from "@composedb/devtools";
import {DID} from "dids";
import {Ed25519Provider} from "key-did-provider-ed25519";
import {getResolver} from "key-did-resolver";
import {fromString} from "uint8arrays";
import {CeramicHost, GenerateFile, GraphqlFile} from "./config.mjs";

const ceramic = new CeramicClient(CeramicHost);

/**
 * @param {import("ora").Ora} spinner - to provide progress status.
 * @return {Promise<void>} - return void when composite finishes deploying.
 */
export const writeComposite = async (spinner) => {
  await authenticate();
  spinner.info("writing composite to Ceramic");

  if (!existsSync(`${GenerateFile}.json`) || !existsSync(`${GenerateFile}.js`)) {
    const createdComposite = await createComposite(ceramic, GraphqlFile);

    const composite = Composite.from([createdComposite]);

    await writeEncodedComposite(composite, `${GenerateFile}.json`);
    spinner.info("creating composite for runtime usage");
    await writeEncodedCompositeRuntime(
      ceramic, `${GenerateFile}.json`, `${GenerateFile}.js`
    );
  }

  spinner.info("deploying composite");
  const deployComposite = await readEncodedComposite(
    ceramic, `${GenerateFile}.json`
  );

  await deployComposite.startIndexingOn(ceramic);
  spinner.succeed("composite deployed & ready for use");
};

/**
 * Authenticating DID for publishing composite
 * @return {Promise<void>} - return void when DID is authenticated.
 */
const authenticate = async () => {
  const seed = readFileSync("./admin_seed.txt");
  // @ts-ignore
  const key = fromString(seed, "base16");
  const did = new DID({
    // @ts-ignore
    resolver: getResolver(),
    provider: new Ed25519Provider(key),
  });
  await did.authenticate();
  ceramic.did = did;
};
