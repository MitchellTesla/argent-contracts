/* global artifacts */
const ethers = require("ethers");
const truffleAssert = require("truffle-assertions");

const BaseWallet = artifacts.require("BaseWallet");
const VersionManager = artifacts.require("VersionManager");
const ModuleRegistry = artifacts.require("ModuleRegistry");
const Factory = artifacts.require("WalletFactory");
const GuardianStorage = artifacts.require("GuardianStorage");

const utils = require("../utils/utilities.js");

const ZERO_ADDRESS = ethers.constants.AddressZero;

contract("WalletFactory", (accounts) => {
  const infrastructure = accounts[0];
  const owner = accounts[1];
  const guardian = accounts[4];
  const other = accounts[6];

  let implementation;
  let moduleRegistry;
  let guardianStorage;
  let factory;
  let versionManager;

  before(async () => {
    implementation = await BaseWallet.new();
    moduleRegistry = await ModuleRegistry.new();
    guardianStorage = await GuardianStorage.new();
    factory = await Factory.new(
      moduleRegistry.address,
      implementation.address,
      guardianStorage.address);
    await factory.addManager(infrastructure);
  });

  async function deployVersionManager() {
    const vm = await VersionManager.new(
      moduleRegistry.address,
      guardianStorage.address,
      ethers.constants.AddressZero,
      ethers.constants.AddressZero,
      ethers.constants.AddressZero);
    await vm.addVersion([], []);
    return vm;
  }

  beforeEach(async () => {
    // Restore the good state of factory (we set these to bad addresses in some tests)
    await factory.changeModuleRegistry(moduleRegistry.address);

    versionManager = await deployVersionManager();
    await moduleRegistry.registerModule(versionManager.address, ethers.utils.formatBytes32String("versionManager"));
  });

  describe("Create and configure the factory", () => {
    it("should not allow to be created with empty ModuleRegistry", async () => {
      await truffleAssert.reverts(Factory.new(
        ZERO_ADDRESS,
        implementation.address,
        guardianStorage.address), "WF: ModuleRegistry address not defined");
    });

    it("should not allow to be created with empty WalletImplementation", async () => {
      await truffleAssert.reverts(Factory.new(
        moduleRegistry.address,
        ZERO_ADDRESS,
        guardianStorage.address), "WF: WalletImplementation address not defined");
    });

    it("should not allow to be created with empty GuardianStorage", async () => {
      await truffleAssert.reverts(Factory.new(
        moduleRegistry.address,
        implementation.address,
        ZERO_ADDRESS), "WF: GuardianStorage address not defined");
    });

    it("should allow owner to change the module registry", async () => {
      const randomAddress = utils.getRandomAddress();
      await factory.changeModuleRegistry(randomAddress);
      const updatedModuleRegistry = await factory.moduleRegistry();
      assert.equal(updatedModuleRegistry, randomAddress);
    });

    it("should not allow owner to change the module registry to zero address", async () => {
      await truffleAssert.reverts(factory.changeModuleRegistry(ethers.constants.AddressZero), "WF: address cannot be null");
    });

    it("should not allow non-owner to change the module registry", async () => {
      const randomAddress = utils.getRandomAddress();
      await truffleAssert.reverts(factory.changeModuleRegistry(randomAddress, { from: other }), "Must be owner");
    });
  });

  describe("Create wallets with CREATE2", () => {
    beforeEach(async () => {
      versionManager = await deployVersionManager();
      await moduleRegistry.registerModule(versionManager.address, ethers.utils.formatBytes32String("versionManager"));
    });

    async function testCreateWallet(from) {
      const salt = utils.generateSaltValue();
      // we get the future address
      const futureAddr = await factory.getAddressForCounterfactualWallet(owner, versionManager.address, guardian, salt, 1);

      let r;
      let s;
      let v;
      if (from === infrastructure) {
        [r, s, v] = ["0x", "0x", 0];
      } else {
        const msg = ethers.utils.hexZeroPad(futureAddr, 32);
        const sig = await utils.signMessage(msg, infrastructure);
        r = `0x${sig.substring(2, 66)}`;
        s = `0x${sig.substring(66, 130)}`;
        v = parseInt(sig.substring(130, 132), 16);
      }

      // we create the wallet
      const tx = await factory.createCounterfactualWallet(
        owner, versionManager.address, guardian, salt, 1, r, s, v, { from }
      );
      const event = await utils.getEvent(tx.receipt, factory, "WalletCreated");
      const walletAddr = event.args.wallet;
      // we test that the wallet is at the correct address
      assert.equal(futureAddr, walletAddr, "should have the correct address");
      // we test that the wallet has the correct owner
      const wallet = await BaseWallet.at(walletAddr);
      const walletOwner = await wallet.owner();
      assert.equal(walletOwner, owner, "should have the correct owner");
      // we test that the wallet has the correct modules
      const isAuthorised = await wallet.authorised(versionManager.address);
      assert.equal(isAuthorised, true, "versionManager should be authorised");
      // we test that the wallet has the correct guardian
      const success = await guardianStorage.isGuardian(walletAddr, guardian);
      assert.equal(success, true, "should have the correct guardian");
    }

    it("should let a manager create a wallet with the correct (owner, modules, guardian) properties", async () => {
      await testCreateWallet(infrastructure);
    });

    it("should let anyone (possessing the right signature) create a wallet with the correct (owner, modules, guardian) properties", async () => {
      await testCreateWallet(owner);
    });

    it("should fail to create a wallet at an existing address", async () => {
      const salt = utils.generateSaltValue();
      // we get the future address
      const futureAddr = await factory.getAddressForCounterfactualWallet(owner, versionManager.address, guardian, salt, 1);
      // we create the first wallet
      const tx = await factory.createCounterfactualWallet(
        owner, versionManager.address, guardian, salt, 1, "0x", "0x", 0
      );
      const event = await utils.getEvent(tx.receipt, factory, "WalletCreated");
      // we test that the wallet is at the correct address
      assert.equal(futureAddr, event.args.wallet, "should have the correct address");
      // we create the second wallet
      await truffleAssert.reverts(factory.createCounterfactualWallet(owner, versionManager.address, guardian, salt, 1, "0x", "0x", 0));
    });

    it("should fail to create counterfactually when there are no modules (with guardian)", async () => {
      const salt = utils.generateSaltValue();
      await truffleAssert.reverts(
        factory.createCounterfactualWallet(
          owner, ZERO_ADDRESS, guardian, salt, 1, "0x", "0x", 0
        ),
        "WF: invalid _versionManager",
      );
    });

    it("should fail to create when the owner is empty", async () => {
      const salt = utils.generateSaltValue();
      await truffleAssert.reverts(
        factory.createCounterfactualWallet(ZERO_ADDRESS, versionManager.address, guardian, salt, 1, "0x", "0x", 0),
        "WF: owner cannot be null",
      );
    });

    it("should fail to create when the guardian is empty", async () => {
      const salt = utils.generateSaltValue();
      await truffleAssert.reverts(
        factory.createCounterfactualWallet(owner, versionManager.address, ZERO_ADDRESS, salt, 1, "0x", "0x", 0),
        "WF: guardian cannot be null",
      );
    });

    it("should fail to create when the owner is the guardian", async () => {
      const salt = utils.generateSaltValue();
      await truffleAssert.reverts(
        factory.createCounterfactualWallet(owner, versionManager.address, owner, salt, 1, "0x", "0x", 0),
        "WF: owner cannot be guardian",
      );
    });

    it("should fail to create when the version is 0", async () => {
      const salt = utils.generateSaltValue();
      await truffleAssert.reverts(
        factory.createCounterfactualWallet(owner, versionManager.address, guardian, salt, 0, "0x", "0x", 0),
        "WF: invalid _version",
      );
    });

    it("should fail to create by a non-manager without a manager's signature", async () => {
      const salt = utils.generateSaltValue();
      await truffleAssert.reverts(
        factory.createCounterfactualWallet(owner, versionManager.address, guardian, salt, 1, "0x", "0x", 0, { from: other }),
        "WF: unauthorised wallet creation",
      );
    });

    it("should emit and event when the balance is non zero at creation", async () => {
      const salt = utils.generateSaltValue();
      const amount = 10000000000000;
      // we get the future address
      const futureAddr = await factory.getAddressForCounterfactualWallet(owner, versionManager.address, guardian, salt, 1);
      // We send ETH to the address
      await web3.eth.sendTransaction({ from: infrastructure, to: futureAddr, value: amount });
      // we create the wallet
      const tx = await factory.createCounterfactualWallet(
        owner, versionManager.address, guardian, salt, 1, "0x", "0x", 0
      );
      const wallet = await BaseWallet.at(futureAddr);
      const event = await utils.getEvent(tx.receipt, wallet, "Received");
      assert.equal(event.args.value, amount, "should log the correct amount");
      assert.equal(event.args.sender, "0x0000000000000000000000000000000000000000", "sender should be address(0)");
    });

    it("should fail to get an address when the guardian is empty", async () => {
      const salt = utils.generateSaltValue();
      await truffleAssert.reverts(
        factory.getAddressForCounterfactualWallet(owner, versionManager.address, ZERO_ADDRESS, salt, 1),
        "WF: guardian cannot be null",
      );
    });
  });

  describe("Managed-like contract logic", () => {
    it("should not be able to add manager if not called by owner", async () => {
      await truffleAssert.reverts(factory.addManager(other, { from: other }), "Must be owner");
    });

    it("should not be able to set manager to zero address", async () => {
      await truffleAssert.reverts(factory.addManager(ethers.constants.AddressZero), "M: Address must not be null");
    });

    it("should be able to set manager twice without error", async () => {
      // Set manager once
      await factory.addManager(other);
      let isManager = await factory.managers(other);
      assert.isTrue(isManager);

      // Set manager twice
      await factory.addManager(other);
      isManager = await factory.managers(other);
      assert.isTrue(isManager);
    });
  });
});
