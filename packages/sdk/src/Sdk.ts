import { anyToBN, anyToBuffer, ZERO_ADDRESS } from '@netgum/utils';
import BN from 'bn.js';
import EthJs from 'ethjs';
import { TAbi } from 'ethjs-abi';
import { BehaviorSubject, from, SubscriptionLike, timer } from 'rxjs';
import { filter, map, switchMap } from 'rxjs/operators';
import { AccountDeviceStates, AccountDeviceTypes, AccountGamePlayers, AccountGameStates, AccountStates } from './constants';
import {
  IAccount,
  IAccountDevice,
  IAccountFriendRecovery,
  IAccountGame,
  IAccountPayment,
  IAccountTransaction,
  IAccountVirtualBalance,
  IApp,
  IEstimatedAccountDeployment,
  IEstimatedAccountProxyTransaction,
  IPaginated,
  IToken,
} from './interfaces';
import {
  AccountFriendRecovery,
  AccountGame,
  AccountPayment,
  AccountTransaction,
  Action,
  Api,
  ApiMethods,
  Contract,
  Device,
  Ens,
  Environment,
  Eth,
  Session,
  State,
  Storage,
  Url,
} from './modules';
import { TAnyData, TAnyNumber } from './types';

/**
 * Sdk
 */
export class Sdk {
  public api: Api;
  public readonly state = new State();

  public readonly error$ = new BehaviorSubject<any>(null);
  public readonly event$ = new BehaviorSubject<Sdk.IEvent>(null);

  protected accountFriendRecovery: AccountFriendRecovery;
  protected accountGame: AccountGame;
  protected accountPayment: AccountPayment;
  protected accountTransaction: AccountTransaction;
  protected action: Action;
  protected apiMethods: ApiMethods;
  protected contract: Contract;
  protected device: Device;
  protected ens: Ens;
  protected eth: Eth & EthJs;
  protected session: Session;
  protected storage: Storage;
  protected url: Url;

  protected subscriptions: SubscriptionLike[] = null;

  /**
   * constructor
   * @param environment
   */
  constructor(private environment: Environment) {
    this.catchError = this.catchError.bind(this);

    this.setEnvironment(environment);
  }

  /**
   * initializes sdk
   * @param options
   */
  public async initialize(options: Sdk.IInitializeOptions = {}): Promise<void> {
    this.require({
      initialized: null,
      accountConnected: null,
    });

    try {
      options = {
        device: options.device || {},
        environment: options.environment || null,
      };
    } catch (err) {
      options = {
        device: {},
        environment: null,
      };
    }

    const { initialized$, initialized } = this.state;

    if (initialized !== null) {
      this.clearSubscriptions();
      this.state.reset();
      initialized$.next(null);
    }

    try {
      this.setEnvironment(options.environment || this.environment);

      await this.device.setup(options.device || {});

      this.addSubscriptions(
        this.action.setup(),
        ...this.url.setup(),
        ...(await this.state.setup(this.storage)),
        this.action.$incoming.subscribe(this.state.incomingAction$),
      );

      await this.session.setup();

      if (this.state.account) {
        await this.verifyAccount();
      }

      initialized$.next(true);

      this.subscribeAccountBalance();
      this.subscribeApiEvents();
      this.subscribeAcceptedActions();

    } catch (err) {
      initialized$.next(false);
      throw new Sdk.Error('not initialized');
    }
  }

  /**
   * resets sdk
   * @param options
   */
  public async reset(options: Sdk.IResetOptions = {}): Promise<void> {
    this.require({
      accountConnected: null,
    });

    try {
      options = {
        device: !!options.device,
        session: !!options.session,
      };
    } catch (err) {
      options = {
        device: false,
        session: false,
      };
    }

    const { accountAddress, accountFriendRecovery$ } = this.state;

    if (accountAddress) {
      await this.disconnectAccount();
    }

    if (options.device) {

      accountFriendRecovery$.next(null);

      await this.device.reset();
    }

    if (options.session) {
      await this.session.reset({
        token: true,
      });
    }
  }

// Account

  /**
   * gets connected accounts
   * @param page
   */
  public async getConnectedAccounts(page = 0): Promise<IPaginated<IAccount>> {
    this.require({
      accountConnected: null,
    });

    return this.apiMethods.getConnectedAccounts(page);
  }

  /**
   * searches account
   * @param address
   * @param ensName
   */
  public async searchAccount({ address, ensName }: { address?: string, ensName?: string }): Promise<IAccount> {
    this.require({
      initialized: null,
      accountConnected: null,
    });

    let result: IAccount = null;

    try {
      if (address) {
        result = await this
          .apiMethods
          .getAccount(address);
      } else if (ensName) {
        result = await this
          .apiMethods
          .searchAccount(ensName);
      }
    } catch (err) {
      result = null;
    }

    if (result) {
      result = await this.prepareAccount(result);
    }

    return result;
  }

  /**
   * creates account
   * @param ensLabel
   * @param ensRootName
   */
  public async createAccount(ensLabel?: string, ensRootName?: string): Promise<IAccount> {
    this.require({
      accountConnected: false,
    });

    const account = await this.apiMethods.createAccount(
      this.ens.buildName(ensLabel, ensRootName),
    );

    this.state.account$.next(await this.prepareAccount(account));

    await this.verifyAccount();

    return this.state.account;
  }

  /**
   * connects account
   * @param accountAddress
   */
  public async connectAccount(accountAddress: string): Promise<IAccount> {
    await this.disconnectAccount();
    await this.verifyAccount(accountAddress);

    return this.state.account;
  }

  /**
   * disconnects account
   */
  public async disconnectAccount(): Promise<void> {
    this.require({
      accountConnected: null,
    });

    const { account$, accountDevice$ } = this.state;

    account$.next(null);
    accountDevice$.next(null);
  }

  /**
   * updates account
   * @param ensLabel
   * @param ensRootName
   */
  public async updateAccount(ensLabel: string, ensRootName?: string): Promise<IAccount> {
    this.require({
      accountCreated: true,
      accountDeviceOwner: true,
    });

    const { accountAddress } = this.state;

    const account = await this.apiMethods.updateAccountEnsName(
      accountAddress,
      this.ens.buildName(ensLabel, ensRootName),
    );

    this.state.account$.next(account);

    return this.state.account;
  }

  /**
   * estimates account deployment
   * @param transactionSpeed
   */
  public async estimateAccountDeployment(transactionSpeed: Eth.TTransactionSpeed = null): Promise<IEstimatedAccountDeployment> {
    this.require({
      accountCreated: true,
      accountDeviceOwner: true,
    });

    const { accountAddress } = this.state;

    return this.apiMethods.estimateAccountDeployment(
      accountAddress,
      await this.eth.getGasPrice(transactionSpeed),
    );
  }

  /**
   * deploys account
   * @param transactionSpeed
   */
  public async deployAccount(transactionSpeed: Eth.TTransactionSpeed = null): Promise<string> {
    this.require({
      accountCreated: true,
      accountDeviceOwner: true,
    });

    const { accountAddress } = this.state;

    return this
      .apiMethods
      .deployAccount(
        accountAddress,
        await this.eth.getGasPrice(transactionSpeed),
      )
      .catch(() => null);
  }

// Account Virtual Balance

  /**
   * estimates top-up account virtual balance
   * @param value
   * @param tokenAddress
   * @param transactionSpeed
   */
  public async estimateTopUpAccountVirtualBalance(
    value: number | string | BN,
    tokenAddress: string = null,
    transactionSpeed: Eth.TTransactionSpeed = null,
  ): Promise<IEstimatedAccountProxyTransaction> {
    this.require({
      accountDeviceOwner: true,
      accountDeviceDeployed: true,
    });

    const { virtualPaymentManager, erc20Token } = this.contract;

    let result: IEstimatedAccountProxyTransaction;

    if (tokenAddress) {
      const data1 = erc20Token
        .encodeMethodInput(
          'approve',
          virtualPaymentManager.address,
          anyToBN(value, { defaults: new BN(0) }),
        );

      const data2 = virtualPaymentManager
        .encodeMethodInput('depositToken', tokenAddress, anyToBN(value, { defaults: new BN(0) }));

      result = await this.estimateAccountTransaction(
        tokenAddress,
        0,
        data1,
        virtualPaymentManager.address,
        0,
        data2,
        transactionSpeed,
      );

    } else {
      result = await this.estimateAccountTransaction(
        virtualPaymentManager.address,
        value,
        Buffer.alloc(0),
        transactionSpeed,
      );
    }

    return result;
  }

  /**
   * estimates withdraw from account virtual balance
   * @param value
   * @param tokenAddress
   * @param transactionSpeed
   */
  public async estimateWithdrawFromAccountVirtualBalance(
    value: number | string | BN,
    tokenAddress: string = null,
    transactionSpeed: Eth.TTransactionSpeed = null,
  ): Promise<IEstimatedAccountProxyTransaction> {
    this.require({
      accountDeviceOwner: true,
      accountDeviceDeployed: true,
    });

    const { accountAddress } = this.state;
    const payment = await this.createAccountPayment(accountAddress, tokenAddress, value);
    const { hash } = await this.accountPayment.signAccountPayment(payment);

    return this.estimateWithdrawAccountPayment(
      hash,
      transactionSpeed,
    );
  }

  /**
   * gets connected account virtual balances
   * @param page
   */
  public async getConnectedAccountVirtualBalances(page = 0): Promise<IPaginated<IAccountVirtualBalance>> {
    this.require();

    const { accountAddress } = this.state;

    return this.apiMethods.getAccountVirtualBalances(accountAddress, page);
  }

  /**
   * gets connected account virtual balance
   * @param symbolOrAddress
   */
  public async getConnectedAccountVirtualBalance(symbolOrAddress: string): Promise<IAccountVirtualBalance> {
    this.require();

    const { accountAddress } = this.state;

    return this.apiMethods.getAccountVirtualBalance(accountAddress, symbolOrAddress);
  }

// Account Friend Recovery

  /**
   * estimates add account friend recovery extension
   * @param transactionSpeed
   */
  public async estimateAddAccountFriendRecoveryExtension(
    transactionSpeed: Eth.TTransactionSpeed = null,
  ): Promise<IEstimatedAccountProxyTransaction> {
    this.require({
      accountDeviceOwner: true,
      accountDeviceDeployed: true,
    });
    const { accountAddress } = this.state;
    const { account } = this.contract;
    const { accountFriendRecovery } = this.contract;

    await this.apiMethods.createAccountDevice(
      accountAddress,
      accountFriendRecovery.address,
      AccountDeviceTypes.Extension,
    ).catch(() => null);

    const data = account.encodeMethodInput(
      'addDevice',
      accountFriendRecovery.address,
      true,
    );

    return this.apiMethods.estimateAccountProxyTransaction(
      accountAddress,
      data,
      await this.eth.getGasPrice(transactionSpeed),
    );
  }

  /**
   * estimates setup account friend recovery extension
   * @param requiredFriends
   * @param friendAddresses
   * @param transactionSpeed
   */
  public async estimateSetupAccountFriendRecoveryExtension(
    requiredFriends: number,
    friendAddresses: string[],
    transactionSpeed: Eth.TTransactionSpeed = null,
  ): Promise<any> {
    this.require({
      accountDeviceOwner: true,
      accountDeviceDeployed: true,
    });

    const { accountFriendRecovery } = this.contract;
    const data = accountFriendRecovery.encodeMethodInput(
      'setup',
      requiredFriends,
      friendAddresses,
    );

    return this.estimateAccountTransaction(
      accountFriendRecovery.address,
      0,
      data,
      transactionSpeed,
    );
  }

  /**
   * gets connect account friend recovery
   */
  public getConnectAccountFriendRecovery(): Promise<IAccountFriendRecovery> {
    this.require();

    const { accountAddress } = this.state;
    return this.apiMethods.getAccountFriendRecovery(accountAddress);
  }

  /**
   * gets account friend recovery
   * @param accountAddress
   */
  public getAccountFriendRecovery(accountAddress: string): Promise<IAccountFriendRecovery> {
    this.require({
      accountConnected: null,
    });

    return this.apiMethods.getAccountFriendRecovery(accountAddress);
  }

  /**
   * starts account friend recovery
   * @param accountAddress
   * @param transactionSpeed
   */
  public async startAccountFriendRecovery(
    accountAddress: string,
    transactionSpeed: Eth.TTransactionSpeed = null,
  ): Promise<IAccountFriendRecovery> {
    this.require({
      accountConnected: null,
    });

    await this.accountFriendRecovery.startAccountFriendRecovery(
      accountAddress,
      await this.eth.getGasPrice(transactionSpeed),
    );

    return this.state.accountFriendRecovery;
  }

  /**
   * collects account friend signature
   * @param friendAddress
   * @param friendSignature
   */
  public async collectAccountFriendSignature(
    friendAddress: string,
    friendSignature: string,
  ): Promise<IAccountFriendRecovery> {
    this.require({
      accountConnected: null,
    });

    await this.accountFriendRecovery.collectAccountFriendSignature(
      friendAddress,
      friendSignature,
    );

    return this.state.accountFriendRecovery;
  }

  /**
   * signs account friend recovery
   * @param accountAddress
   * @param deviceAddress
   * @param transactionSpeed
   */
  public async signAccountFriendRecovery(
    accountAddress: string,
    deviceAddress: string,
    transactionSpeed: Eth.TTransactionSpeed = null,
  ): Promise<string> {
    this.require({
      accountConnected: null,
    });

    return this.accountFriendRecovery.signAccountFriendRecovery(
      accountAddress,
      deviceAddress,
      await this.eth.getGasPrice(transactionSpeed),
    );
  }

  /**
   * cancels account friend recovery
   */
  public async cancelAccountFriendRecovery(): Promise<void> {
    this.require({
      accountConnected: null,
    });

    await this.accountFriendRecovery.cancelAccountFriendRecovery();
  }

  /**
   * submits account friend recovery
   */
  public async submitAccountFriendRecovery(): Promise<string> {
    this.require({
      accountConnected: null,
    });

    return this.accountFriendRecovery
      .submitAccountFriendRecovery()
      .catch(() => null);
  }

// Account Device

  /**
   * gets connected account devices
   * @param page
   */
  public async getConnectedAccountDevices(page = 0): Promise<IPaginated<IAccountDevice>> {
    this.require();

    const { accountAddress } = this.state;

    return this.apiMethods.getAccountDevices(accountAddress, page);
  }

  /**
   * gets connected account devices
   * @param deviceAddress
   */
  public async getConnectedAccountDevice(deviceAddress: string): Promise<IAccountDevice> {
    this.require();

    const { accountAddress } = this.state;

    return this.apiMethods.getAccountDevice(accountAddress, deviceAddress);
  }

  /**
   * gets account device
   * @param accountAddress
   * @param deviceAddress
   */
  public async getAccountDevice(accountAddress: string = null, deviceAddress: string): Promise<IAccountDevice> {
    this.require({
      accountConnected: null,
    });

    return this.apiMethods.getAccountDevice(accountAddress, deviceAddress);
  }

  /**
   * creates account device
   * @param deviceAddress
   */
  public async createAccountDevice(deviceAddress: string): Promise<IAccountDevice> {
    this.require({
      accountDeviceOwner: true,
    });

    const { accountAddress } = this.state;

    return this.apiMethods.createAccountDevice(accountAddress, deviceAddress, AccountDeviceTypes.Owner);
  }

  /**
   * removes account device
   * @param deviceAddress
   */
  public async removeAccountDevice(deviceAddress: string): Promise<boolean> {
    this.require({
      accountDeviceOwner: true,
    });

    const { accountAddress } = this.state;

    return this.apiMethods.removeAccountDevice(accountAddress, deviceAddress);
  }

  /**
   * estimates account device deployment
   * @param deviceAddress
   * @param transactionSpeed
   */
  public async estimateAccountDeviceDeployment(
    deviceAddress: string,
    transactionSpeed: Eth.TTransactionSpeed = null,
  ): Promise<IEstimatedAccountProxyTransaction> {
    this.require({
      accountDeviceOwner: true,
      accountDeviceDeployed: true,
    });

    const { accountAddress } = this.state;
    const { account } = this.contract;

    const data = account.encodeMethodInput(
      'addDevice',
      deviceAddress,
      true,
    );

    return this.apiMethods.estimateAccountProxyTransaction(
      accountAddress,
      data,
      await this.eth.getGasPrice(transactionSpeed),
    );
  }

  /**
   * estimates account device un-deployment
   * @param deviceAddress
   * @param transactionSpeed
   */
  public async estimateAccountDeviceUnDeployment(
    deviceAddress: string,
    transactionSpeed: Eth.TTransactionSpeed = null,
  ): Promise<IEstimatedAccountProxyTransaction> {
    this.require({
      accountDeviceOwner: true,
      accountDeviceDeployed: true,
    });

    const { accountAddress } = this.state;
    const { account } = this.contract;

    const data = account.encodeMethodInput(
      'removeDevice',
      deviceAddress,
    );

    return this.apiMethods.estimateAccountProxyTransaction(
      accountAddress,
      data,
      await this.eth.getGasPrice(transactionSpeed),
    );
  }

// Account Transaction

  /**
   * gets connected account transactions
   * @param hash
   * @param page
   */
  public async getConnectedAccountTransactions(hash = '', page = 0): Promise<IPaginated<IAccountTransaction>> {
    this.require();

    const { accountAddress } = this.state;

    return this.apiMethods.getAccountTransactions(accountAddress, page, hash);
  }

  /**
   * gets connected account transaction
   * @param hash
   * @param index
   */
  public async getConnectedAccountTransaction(hash: string, index = 0): Promise<IAccountTransaction> {
    this.require({
      accountConnected: true,
    });

    const { accountAddress } = this.state;

    return this.apiMethods.getAccountTransaction(accountAddress, hash, index);
  }

  /**
   * gets account transaction
   * @param accountAddress
   * @param hash
   * @param index
   */
  public async getAccountTransaction(accountAddress: string, hash: string, index = 0): Promise<IAccountTransaction> {
    this.require({
      accountConnected: null,
    });

    return this.apiMethods.getAccountTransaction(accountAddress, hash, index);
  }

  /**
   * estimates account transaction
   * @param recipient1
   * @param value1
   * @param data1
   * @param transactionSpeed
   */
  public async estimateAccountTransaction(
    recipient1: string, value1: TAnyNumber, data1: TAnyData,
    transactionSpeed?: Eth.TTransactionSpeed,
  ): Promise<IEstimatedAccountProxyTransaction>;

  /**
   * estimates account transaction
   * @param recipient1
   * @param value1
   * @param data1
   * @param recipient2
   * @param value2
   * @param data2
   * @param transactionSpeed
   */
  public async estimateAccountTransaction(
    recipient1: string, value1: TAnyNumber, data1: TAnyData,
    recipient2: string, value2: TAnyNumber, data2: TAnyData,
    transactionSpeed?: Eth.TTransactionSpeed,
  ): Promise<IEstimatedAccountProxyTransaction>;

  /**
   * estimates account transaction
   * @param recipient1
   * @param value1
   * @param data1
   * @param recipient2
   * @param value2
   * @param data2
   * @param recipient3
   * @param value3
   * @param data3
   * @param transactionSpeed
   */
  public async estimateAccountTransaction(
    recipient1: string, value1: TAnyNumber, data1: TAnyData,
    recipient2: string, value2: TAnyNumber, data2: TAnyData,
    recipient3: string, value3: TAnyNumber, data3: TAnyData,
    transactionSpeed?: Eth.TTransactionSpeed,
  ): Promise<IEstimatedAccountProxyTransaction>;

  /**
   * estimates account transaction
   * @param recipient1
   * @param value1
   * @param data1
   * @param recipient2
   * @param value2
   * @param data2
   * @param recipient3
   * @param value3
   * @param data3
   * @param recipient4
   * @param value4
   * @param data4
   * @param transactionSpeed
   */
  public async estimateAccountTransaction(
    recipient1: string, value1: TAnyNumber, data1: TAnyData,
    recipient2: string, value2: TAnyNumber, data2: TAnyData,
    recipient3: string, value3: TAnyNumber, data3: TAnyData,
    recipient4: string, value4: TAnyNumber, data4: TAnyData,
    transactionSpeed?: Eth.TTransactionSpeed,
  ): Promise<IEstimatedAccountProxyTransaction>;

  /**
   * estimates account transaction
   * @param recipient1
   * @param value1
   * @param data1
   * @param recipient2
   * @param value2
   * @param data2
   * @param recipient3
   * @param value3
   * @param data3
   * @param recipient4
   * @param value4
   * @param data4
   * @param recipient5
   * @param value5
   * @param data5
   * @param transactionSpeed
   */
  public async estimateAccountTransaction(
    recipient1: string, value1: TAnyNumber, data1: TAnyData,
    recipient2: string, value2: TAnyNumber, data2: TAnyData,
    recipient3: string, value3: TAnyNumber, data3: TAnyData,
    recipient4: string, value4: TAnyNumber, data4: TAnyData,
    recipient5: string, value5: TAnyNumber, data5: TAnyData,
    transactionSpeed?: Eth.TTransactionSpeed,
  ): Promise<IEstimatedAccountProxyTransaction>;

  public async estimateAccountTransaction(...args: any[]): Promise<IEstimatedAccountProxyTransaction> {
    this.require({
      accountDeviceOwner: true,
      accountDeviceDeployed: true,
    });

    const { accountAddress } = this.state;
    const { account } = this.contract;
    const proxyData: string[] = [];
    let transactionSpeed: Eth.TTransactionSpeed = null;

    const addToProxyData = (index) => {
      const recipient = args[index * 3];
      const value = args[index * 3 + 1];
      const data = args[index * 3 + 2];

      proxyData.push(account.encodeMethodInput(
        'executeTransaction',
        recipient,
        anyToBN(value, { defaults: new BN(0) }),
        anyToBuffer(data, { defaults: Buffer.alloc(0) }),
        ),
      );
    };

    switch (args.length) {
      case 3:
      case 4:
        addToProxyData(0);
        transactionSpeed = args[3] || null;
        break;
      case 6:
      case 7:
        addToProxyData(0);
        addToProxyData(1);
        transactionSpeed = args[6] || null;
        break;
      case 9:
      case 10:
        addToProxyData(0);
        addToProxyData(1);
        addToProxyData(2);
        transactionSpeed = args[9] || null;
        break;
      case 12:
      case 13:
        addToProxyData(0);
        addToProxyData(1);
        addToProxyData(2);
        addToProxyData(3);
        transactionSpeed = args[12] || null;
        break;

      case 15:
      case 16:
        addToProxyData(0);
        addToProxyData(1);
        addToProxyData(2);
        addToProxyData(3);
        addToProxyData(4);
        transactionSpeed = args[15] || null;
        break;

      default:
        throw new Sdk.Error('invalid number of args');
    }

    return this.apiMethods.estimateAccountProxyTransaction(
      accountAddress,
      proxyData,
      await this.eth.getGasPrice(transactionSpeed),
    );
  }

  /**
   * submits account transaction
   * @param estimated
   */
  public async submitAccountTransaction(estimated: IEstimatedAccountProxyTransaction): Promise<string> {
    this.require({
      accountDeviceOwner: true,
      accountDeviceDeployed: true,
    });

    return this
      .accountTransaction
      .submitAccountProxyTransaction(estimated)
      .catch(() => null);
  }

// Account Payment

  /**
   * gets connected account payments
   * @param page
   */
  public async getConnectedAccountPayments(page = 0): Promise<IPaginated<IAccountPayment>> {
    this.require();

    const { accountAddress } = this.state;

    return this.apiMethods.getAccountPayments(accountAddress, page);
  }

  /**
   * get connected account payment
   * @param hash
   */
  public async getConnectedAccountPayment(hash: string): Promise<IAccountPayment> {
    this.require();

    const { accountAddress } = this.state;

    return this.apiMethods.getAccountPayment(accountAddress, hash);
  }

  /**
   * creates account payment
   * @param recipient
   * @param tokenAddress
   * @param value
   */
  public async createAccountPayment(
    recipient: string,
    tokenAddress: string,
    value: number | string | BN,
  ): Promise<IAccountPayment> {
    this.require({
      accountDeviceOwner: true,
      accountDeviceDeployed: !!recipient,
    });

    return this.accountPayment.createAccountPayment(
      recipient,
      tokenAddress,
      value,
    );
  }

  /**
   * signs account payment
   * @param hash
   */
  public async signAccountPayment(hash: string): Promise<IAccountPayment> {
    this.require({
      accountDeviceOwner: true,
      accountDeviceDeployed: true,
    });

    const { accountAddress } = this.state;

    const payment = await this.apiMethods.getAccountPayment(accountAddress, hash);

    return this.accountPayment.signAccountPayment(payment);
  }

  /**
   * grab account payment
   * @param hash
   * @param recipient
   */
  public async grabAccountPayment(hash: string, recipient: string = null): Promise<IAccountPayment> {
    this.require();

    const { accountAddress } = this.state;

    return this.apiMethods.grabAccountPayment(accountAddress, hash, recipient);
  }

  /**
   * cancel account payment
   * @param hash
   */
  public async cancelAccountPayment(hash: string): Promise<boolean> {
    this.require({
      accountDeviceOwner: true,
    });

    const { accountAddress } = this.state;

    return this.apiMethods.cancelAccountPayment(accountAddress, hash);
  }

  /**
   * estimates deposit account payment
   * @param hash
   * @param transactionSpeed
   */
  public async estimateDepositAccountPayment(
    hash: string,
    transactionSpeed: Eth.TTransactionSpeed = null,
  ): Promise<IEstimatedAccountProxyTransaction> {
    this.require({
      accountDeviceOwner: true,
      accountDeviceDeployed: true,
    });

    const { accountAddress } = this.state;
    const { sender, recipient, guardian, token, value } = await this.apiMethods.getAccountPayment(accountAddress, hash);
    const { virtualPaymentManager } = this.contract;
    const data = virtualPaymentManager.encodeMethodInput(
      'depositPayment',
      sender.account.address,
      recipient.address || recipient.account.address,
      token && token.address ? token.address : ZERO_ADDRESS,
      hash,
      value,
      sender.signature,
      guardian.signature,
    );

    return this.estimateAccountTransaction(
      virtualPaymentManager.address,
      null,
      data,
      transactionSpeed,
    );
  }

  /**
   * estimate withdraw account payment
   * @param hash
   * @param transactionSpeed
   */
  public async estimateWithdrawAccountPayment(
    hash: string,
    transactionSpeed: Eth.TTransactionSpeed = null,
  ): Promise<IEstimatedAccountProxyTransaction> {
    this.require({
      accountDeviceOwner: true,
      accountDeviceDeployed: true,
    });

    const { accountAddress } = this.state;
    const { sender, recipient, guardian, value, token } = await this.apiMethods.getAccountPayment(accountAddress, hash);
    const { virtualPaymentManager } = this.contract;
    const data = virtualPaymentManager.encodeMethodInput(
      'withdrawPayment',
      sender.account.address,
      recipient.address || recipient.account.address,
      token && token.address ? token.address : ZERO_ADDRESS,
      hash,
      value,
      sender.signature,
      guardian.signature,
    );

    return this.estimateAccountTransaction(
      virtualPaymentManager.address,
      null,
      data,
      transactionSpeed,
    );
  }

// Account Game

  /**
   * gets connected account games
   * @param appAlias
   * @param page
   */
  public async getConnectedAccountGames(appAlias: string, page = 0): Promise<IPaginated<IAccountGame>> {
    this.require();

    const { accountAddress } = this.state;

    return this.apiMethods.getAccountGames(accountAddress, appAlias, page);
  }

  /**
   * gets account game
   * @param gameId
   */
  public async getAccountGame(gameId: number): Promise<IAccountGame> {
    this.require();

    const { accountAddress } = this.state;

    return this.apiMethods.getAccountGame(accountAddress, gameId);
  }

  /**
   * create account game
   * @param appAlias
   * @param deposit
   * @param data
   */
  public async createAccountGame(
    appAlias: string,
    deposit: {
      value: number | string | BN;
      token?: string;
    },
    data: string,
  ): Promise<IAccountGame> {
    this.require({
      accountDeviceOwner: true,
    });

    const { accountAddress } = this.state;

    return this.apiMethods.createAccountGame(accountAddress, appAlias, deposit, data);
  }

  /**
   * joins account game
   * @param gameId
   */
  public async joinAccountGame(gameId: number): Promise<IAccountGame> {
    this.require({
      accountDeviceOwner: true,
      accountDeviceDeployed: true,
    });

    const { accountAddress } = this.state;
    const game = await this.apiMethods.getAccountGame(accountAddress, gameId);

    if (game.creator.account.address === accountAddress) {
      throw new Sdk.Error('invalid game creator');
    }

    if (game.state !== AccountGameStates.Open) {
      throw new Sdk.Error('invalid game state');
    }

    return this.accountGame.joinAccountGame(game);
  }

  /**
   * cancel account game
   * @param gameId
   */
  public cancelAccountGame(gameId: number): Promise<boolean> {
    this.require({
      accountDeviceOwner: true,
    });

    const { accountAddress } = this.state;

    return this.apiMethods.cancelAccountGame(accountAddress, gameId);
  }

  /**
   * starts account game
   * @param gameId
   */
  public async startAccountGame(gameId: number): Promise<IAccountGame> {
    this.require({
      accountDeviceOwner: true,
      accountDeviceDeployed: true,
    });

    const { accountAddress } = this.state;
    const game = await this.apiMethods.getAccountGame(accountAddress, gameId);

    if (game.creator.account.address !== accountAddress) {
      throw new Sdk.Error('invalid game creator');
    }

    if (game.state !== AccountGameStates.Opened) {
      throw new Sdk.Error('invalid game state');
    }

    return this.accountGame.startAccountGame(game);
  }

  /**
   * updates account game
   * @param gameId
   * @param data
   */
  public async updateAccountGame(gameId: number, data: string): Promise<IAccountGame> {
    this.require();

    const { accountAddress } = this.state;
    const game = await this.apiMethods.getAccountGame(accountAddress, gameId);

    if (
      game.state !== AccountGameStates.Started ||
      (game.whoseTurn === AccountGamePlayers.Creator && game.creator.account.address !== accountAddress) ||
      (game.whoseTurn === AccountGamePlayers.Opponent && game.opponent.account.address !== accountAddress)
    ) {
      throw new Sdk.Error('invalid game state');
    }

    return this.apiMethods.updateAccountGame(accountAddress, game.id, data);
  }

// App

  /**
   * gets apps
   * @param page
   */
  public async getApps(page = 0): Promise<IPaginated<IApp>> {
    this.require({
      accountConnected: null,
    });

    return this.apiMethods.getApps(page);
  }

  /**
   * gets app
   * @param appAlias
   */
  public async getApp(appAlias: string): Promise<IApp> {
    this.require({
      accountConnected: null,
    });

    return this.apiMethods.getApp(appAlias);
  }

  /**
   * gets app open games
   * @param appAlias
   * @param page
   */
  public async getAppOpenGames(appAlias: string, page = 0): Promise<IPaginated<IAccountGame>> {
    this.require({
      accountConnected: null,
    });

    return this.apiMethods.getAppOpenGames(appAlias, page);
  }

// Token

  /**
   * gets tokens
   * @param page
   */
  public async getTokens(page = 0): Promise<IPaginated<IToken>> {
    this.require({
      accountConnected: null,
    });

    return this.apiMethods.getTokens(page);
  }

  /**
   * gets token
   * @param symbolOrAddress
   */
  public async getToken(symbolOrAddress: string): Promise<IToken> {
    this.require({
      accountConnected: null,
    });

    return this.apiMethods.getToken(symbolOrAddress);
  }

// Action

  /**
   * accepts incoming action
   * @param action
   */
  public acceptIncomingAction(action: Action.IAction = null): this {
    this.require({
      accountConnected: null,
    });

    this.action.acceptAction(action);
    return this;
  }

  /**
   * dismisses incoming action
   */
  public dismissIncomingAction(): void {
    this.require({
      accountConnected: null,
    });

    this.action.dismissAction();
  }

// Url

  /**
   * processes incoming url
   * @param url
   */
  public processIncomingUrl(url: string): void {
    this.require({
      accountConnected: null,
    });

    this.url.incoming$.next(url);
  }

  /**
   * creates request add account device url
   * @param options
   */
  public createRequestAddAccountDeviceUrl(options: { account?: string, endpoint?: string, callbackEndpoint?: string } = {}): string {
    this.require({
      accountConnected: false,
    });

    const { deviceAddress } = this.state;
    const action = Action.createAction<Action.IRequestAddAccountDevicePayload>(
      Action.Types.RequestAddAccountDevice,
      {
        device: deviceAddress,
        account: options.account || null,
        callbackEndpoint: options.callbackEndpoint || null,
      },
    );

    return this.url.buildActionUrl(action, options.endpoint || null);
  }

  /**
   * creates request sign secure code url
   */
  public async createRequestSignSecureCodeUrl(): Promise<string> {
    this.require({
      accountDeviceOwner: true,
    });

    const { deviceAddress } = this.state;

    const code = await this.session.createCode();
    const action = Action.createAction<Action.IRequestSignSecureCodePayload>(
      Action.Types.RequestSignSecureCode,
      {
        code,
        creator: deviceAddress,
      },
    );

    return this.url.buildActionUrl(action);
  }

// Utils

  /**
   * signs personal message
   * @param message
   */
  public signPersonalMessage(message: string | Buffer): Buffer {
    this.require({
      accountConnected: null,
    });

    return this.device.signPersonalMessage(message);
  }

  /**
   * creates contract instance
   * @param abi
   * @param address
   */
  public createContractInstance(abi: TAbi, address: string = null): Contract.ContractInstance {
    return this.contract.createInstance(abi, address);
  }

// Protected

  protected setEnvironment(environment: Environment): void {
    this.storage = new Storage(
      environment.getConfig('storageOptions'),
      environment.getConfig('storageAdapter'),
    );

    this.api = new Api(
      environment.getConfig('apiOptions'),
      environment.getConfig('apiWebSocketConstructor'),
      this.state,
    );

    this.apiMethods = new ApiMethods(this.api);

    this.device = new Device(
      this.state,
      this.storage.createChild(Sdk.StorageNamespaces.Device),
    );

    this.session = new Session(this.api, this.device, this.state);
    this.eth = new Eth(
      environment.getConfig('ethOptions'),
      this.api,
      this.state,
    );
    this.ens = new Ens(
      environment.getConfig('ensOptions'),
      this.eth,
      this.state,
    );

    this.contract = new Contract(this.eth);
    this.action = new Action(
      environment.getConfig('actionOptions'),
    );
    this.url = new Url(
      environment.getConfig('urlOptions'),
      environment.getConfig('urlAdapter'),
      this.action,
      this.eth,
    );

    this.accountTransaction = new AccountTransaction(this.apiMethods, this.contract, this.device, this.state);
    this.accountPayment = new AccountPayment(this.apiMethods, this.contract, this.device, this.state);
    this.accountGame = new AccountGame(this.apiMethods, this.contract, this.device, this.state);
    this.accountFriendRecovery = new AccountFriendRecovery(this.apiMethods, this.contract, this.device, this.state);
  }

  protected addSubscriptions(...subscriptions: SubscriptionLike[]): void {
    this.subscriptions = [
      ...(this.subscriptions || []),
      ...subscriptions.filter(subscription => !!subscription),
    ];
  }

  protected removeSubscriptions(subscription: SubscriptionLike): SubscriptionLike {
    if (
      subscription &&
      this.subscriptions &&
      this.subscriptions.includes(subscription)
    ) {
      subscription.unsubscribe();
      this.subscriptions = this.subscriptions.filter(item => item !== subscription);
      if (!this.subscriptions.length) {
        this.subscriptions = null;
      }
    }

    return null;
  }

  protected clearSubscriptions(): void {
    if (this.subscriptions) {
      for (const subscription of this.subscriptions) {
        subscription.unsubscribe();
      }
      this.subscriptions = null;
    }
  }

  protected async prepareAccount(account: IAccount): Promise<IAccount> {
    try {

      const balance = await this.eth.getBalance(account.address, 'pending');
      if (balance) {
        account.balance.real = balance;
      }
    } catch (err) {
      //
    }

    return account;
  }

  protected async verifyAccount(accountAddress: string = null): Promise<void> {
    if (!accountAddress) {
      ({ accountAddress } = this.state);
    }

    const {
      account$,
      accountDevice$,
      deviceAddress,
    } = this.state;

    let account: IAccount = null;
    let accountDevice: IAccountDevice = null;

    if (accountAddress) {
      account = await this.apiMethods.getAccount(accountAddress).catch(() => null);
      if (account) {
        account = await this.prepareAccount(account);
        accountDevice = await this.apiMethods.getAccountDevice(accountAddress, deviceAddress).catch(() => null);
      }
    }
    account$.next(account && accountDevice ? account : null);
    accountDevice$.next(accountDevice);
  }

  protected subscribeAccountBalance(): void {
    const { account$ } = this.state;

    let subscription: SubscriptionLike = null;

    account$
      .subscribe((account) => {
        if (account) {
          if (!subscription) {
            subscription = timer(5000, 5000)
              .pipe(
                switchMap(() => from(
                  this
                    .eth
                    .getBalance(account.address, 'pending')
                    .catch(() => null)),
                ),
                filter(balance => !!balance),
                map((real) => {
                  const { account } = this.state;

                  return {
                    ...account,
                    balance: {
                      real,
                      virtual: account.balance.virtual,
                    },
                  };
                }),
                filter(account => !!account),
              )
              .subscribe(account$);

            this.addSubscriptions(subscription);
          }
        } else if (subscription) {
          this.removeSubscriptions(subscription);
          subscription = null;
        }
      });
  }

  protected subscribeApiEvents(): void {
    const { event$ } = this.api;

    this.addSubscriptions(
      {
        closed: false,
        unsubscribe(): void {
          event$.complete();
        },
      },
      event$
        .pipe(
          filter(event => !!event),
          switchMap(({ name, payload }) => from(this.wrapAsync(async () => {
            const { account$, accountDevice$, deviceAddress, accountAddress } = this.state;

            switch (name) {
              case Api.EventNames.AccountUpdated: {
                const { account } = payload;
                if (accountAddress === account) {
                  const account = await this.apiMethods.getAccount(accountAddress);
                  if (account) {
                    account$.next(account);
                  }
                } else {
                  const account = await this.apiMethods.getAccount(accountAddress);
                  this.emitEvent(Sdk.EventNames.AccountUpdated, account);
                }
                break;
              }

              case Api.EventNames.AccountFriendRecoveryUpdated: {
                const { account } = payload;
                if (accountAddress === account) {
                  const accountFriendRecovery = await this.apiMethods.getAccountFriendRecovery(accountAddress);
                  this.emitEvent(Sdk.EventNames.AccountFriendRecoveryUpdated, accountFriendRecovery);
                }
                break;
              }

              case Api.EventNames.AccountDeviceUpdated: {
                const { account, device } = payload;
                if (deviceAddress === device) {
                  switch (accountAddress) {
                    case account:
                      const accountDevice = await this.apiMethods.getAccountDevice(account, device);
                      if (accountDevice) {
                        accountDevice$.next(accountDevice);
                      }
                      break;

                    case null:
                      await this.verifyAccount(account);
                      break;

                    default:
                  }
                } else if (account === accountAddress) {
                  const accountDevice = await this.apiMethods.getAccountDevice(accountAddress, device);
                  this.emitEvent(Sdk.EventNames.AccountDeviceUpdated, accountDevice);
                }
                break;
              }
              case Api.EventNames.AccountDeviceRemoved: {
                const { account, device } = payload;
                if (accountAddress === account) {
                  if (deviceAddress === device) {
                    await this.reset();
                  } else {
                    this.emitEvent(Sdk.EventNames.AccountDeviceRemoved, device);
                  }
                }
                break;
              }
              case Api.EventNames.AccountVirtualBalanceUpdated: {
                const { account, token } = payload;
                if (accountAddress === account) {
                  const accountVirtualBalance = await this.apiMethods.getAccountVirtualBalance(accountAddress, token);
                  this.emitEvent(Sdk.EventNames.AccountVirtualBalanceUpdated, accountVirtualBalance);
                }
                break;
              }
              case Api.EventNames.AccountTransactionUpdated: {
                const { account, hash, index } = payload;
                if (accountAddress === account) {
                  const accountTransaction = await this.apiMethods.getAccountTransaction(accountAddress, hash, index);
                  this.emitEvent(Sdk.EventNames.AccountTransactionUpdated, accountTransaction);
                }
                break;
              }
              case Api.EventNames.AccountGameUpdated: {
                const { account, game } = payload;
                if (accountAddress === account) {
                  const accountGame = await this.apiMethods.getAccountGame(accountAddress, game);
                  this.emitEvent(Sdk.EventNames.AccountGameUpdated, accountGame);
                }
                break;
              }
              case Api.EventNames.AccountPaymentUpdated: {
                const { account, hash } = payload;
                if (accountAddress === account) {
                  const accountPayment = await this.apiMethods.getAccountPayment(accountAddress, hash);
                  this.emitEvent(Sdk.EventNames.AccountPaymentUpdated, accountPayment);
                }
                break;
              }
              case Api.EventNames.SecureCodeSigned: {
                const { device, code } = payload;
                if (
                  deviceAddress &&
                  accountAddress &&
                  this.session.verifyCode(code)
                ) {
                  const action = Action
                    .createAction<Action.IRequestAddAccountDevicePayload>(
                      Action.Types.RequestAddAccountDevice, {
                        device,
                        account: accountAddress,
                      },
                    );

                  this.action.$incoming.next(action);
                }
                break;
              }
            }
          }))),
        )
        .subscribe(),
    );
  }

  protected subscribeAcceptedActions(): void {
    const { account$ } = this.state;
    const { $accepted } = this.action;

    let hasAccount = null;
    let subscription: SubscriptionLike = null;

    account$
      .subscribe((account) => {
        if (hasAccount === !!account) {
          return;
        }

        hasAccount = !!account;

        this.removeSubscriptions(subscription);

        subscription = $accepted
          .pipe(
            filter(action => !!action),
            switchMap(({ type, payload }) => from(this.wrapAsync(async () => {
              const { accountAddress } = this.state;

              switch (type) {
                case Action.Types.RequestAddAccountDevice: {
                  const { device, account, callbackEndpoint } = payload as Action.IRequestAddAccountDevicePayload;
                  if (
                    accountAddress &&
                    device &&
                    (!account || accountAddress === account)
                  ) {
                    await this.createAccountDevice(device);
                    if (callbackEndpoint) {
                      const action = Action
                        .createAction<Action.IAccountDeviceAddedPayload>(
                          Action.Types.AccountDeviceAdded, {
                            account: accountAddress,
                          },
                        );

                      this.url.openActionUrl(action, callbackEndpoint);
                    }
                  }
                  break;
                }

                case Action.Types.AccountDeviceAdded: {
                  if (!accountAddress) {
                    const { account } = payload as Action.IAccountDeviceAddedPayload;
                    await this.verifyAccount(account);
                  }
                  break;
                }

                case Action.Types.RequestSignSecureCode: {
                  if (!accountAddress) {
                    const { code, creator } = payload as Action.IRequestSignSecureCodePayload;
                    await this.session.signCode(creator, code);
                  }
                  break;
                }
              }
            }))),
            map(() => null),
          )
          .subscribe($accepted);

        this.addSubscriptions(subscription);
      });
  }

  protected wrapAsync(wrapped: () => Promise<void>): Promise<void> {
    return wrapped()
      .catch((err) => {
        this.catchError(err);
        return null;
      });
  }

  protected catchError(err): void {
    this.error$.next(err);
  }

  protected emitEvent<T = any>(name: Sdk.EventNames, payload: T): void {
    this.event$.next({
      name,
      payload,
    });
  }

  protected require(options: Sdk.IRequireOptions = {}): void {
    const {
      account,
      accountDevice,
      initialized,
    } = this.state;

    options = {
      initialized: true,
      accountConnected: true,
      ...options,
    };

    const accountState = account && !account.nextState
      ? account.state
      : null;

    const accountDeviceState = accountDevice && !accountDevice.nextState
      ? accountDevice.state
      : null;
    const accountDeviceType = accountDevice
      ? accountDevice.type
      : null;

    if (options.initialized === true && !initialized) {
      throw new Sdk.Error('sdk not initialized');
    }
    if (options.initialized === false && initialized) {
      throw new Sdk.Error('sdk already initialized');
    }
    if (options.accountConnected === true && !account) {
      throw new Sdk.Error('account disconnected');
    }
    if (options.accountConnected === false && account) {
      throw new Sdk.Error('account already connected');
    }
    if (options.accountCreated && accountState !== AccountStates.Created) {
      throw new Sdk.Error('account should be in Created state');
    }
    if (options.accountDeployed && accountState !== AccountStates.Deployed) {
      throw new Sdk.Error('account should be in Deployed state');
    }
    if (options.accountDeviceCreated && accountDeviceState !== AccountDeviceStates.Created) {
      throw new Sdk.Error('account device should be in Created state');
    }
    if (options.accountDeviceDeployed && accountDeviceState !== AccountDeviceStates.Deployed) {
      throw new Sdk.Error('account device should be in Deployed state');
    }
    if (options.accountDeviceOwner && accountDeviceType !== AccountDeviceTypes.Owner) {
      throw new Sdk.Error('account device is not an Owner');
    }
  }
}

export namespace Sdk {
  export enum StorageNamespaces {
    Device = 'device',
  }

  export class Error extends global.Error {
    //
  }

  export interface IInitializeOptions {
    device?: Device.ISetupOptions;
    environment?: Environment;
  }

  export interface IResetOptions {
    device?: boolean;
    session?: boolean;
  }

  export interface IRequireOptions {
    accountConnected?: boolean;
    accountCreated?: boolean;
    accountDeployed?: boolean;
    accountDeviceCreated?: boolean;
    accountDeviceDeployed?: boolean;
    accountDeviceOwner?: boolean;
    initialized?: boolean;
  }

  export enum EventNames {
    AccountUpdated = 'AccountUpdated',
    AccountDeviceUpdated = 'AccountDeviceUpdated',
    AccountDeviceRemoved = 'AccountDeviceRemoved',
    AccountFriendRecoveryUpdated = 'AccountFriendRecoveryUpdated',
    AccountTransactionUpdated = 'AccountTransactionUpdated',
    AccountVirtualBalanceUpdated = 'AccountVirtualBalanceUpdated',
    AccountPaymentUpdated = 'AccountPaymentUpdated',
    AccountGameUpdated = 'AccountGameUpdated',
  }

  export interface IEvent<T = any> {
    name: EventNames;
    payload: T;
  }
}
