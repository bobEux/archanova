import { jsonReplacer, jsonReviver } from '@netgum/utils';
import { Subject, Subscription } from 'rxjs';
import { filter, map, tap } from 'rxjs/operators';
import { UniqueBehaviorSubject } from 'rxjs-addons';
import { Action } from './Action';
import { Eth } from './Eth';

export class Url {

  private static QUERY_FIELD_NAME = 'asq';
  private static DEFAULT_ENDPOINT = '://';

  public incoming$ = new UniqueBehaviorSubject<string>(null);
  public outgoing$ = new Subject<string>();

  constructor(
    private options: Url.IOptions,
    private adapter: Url.IAdapter,
    private action: Action,
    private eth: Eth,
  ) {
    //
  }

  public setup(): Subscription[] {
    const result: Subscription[] = [
      this
        .incoming$
        .pipe(
          map(url => this.urlToAction(url)),
          filter(action => !!action),
          tap(() => {
            this.incoming$.next(null);
          }),
        )
        .subscribe(this.action.$incoming),
    ];

    if (this.adapter) {
      let active = true;
      const listener = (url) => {
        if (active) {
          this.incoming$.next(url || null);
        }
      };

      this.adapter.addListener(listener);

      const subscription: Subscription = this
        .outgoing$
        .pipe(
          filter(url => !!url),
        )
        .subscribe(url => this.adapter.open(url));

      const unsubscribe = subscription.unsubscribe.bind(subscription);

      subscription.unsubscribe = () => {
        active = false;
        if (this.adapter.removeListener) {
          this.adapter.removeListener(listener);
        }
        unsubscribe();
      };

      result.push(subscription);
    }

    return result;
  }

  public buildActionUrl(action: Action.IAction, endpoint: string = null): string {
    if (!endpoint) {
      endpoint = this.options && this.options.endpoint
        ? this.options.endpoint
        : Url.DEFAULT_ENDPOINT;
    }

    return this.actionToUrl(action, endpoint);
  }

  public openActionUrl(action: Action.IAction, endpoint: string = null): void {
    const url = this.buildActionUrl(action, endpoint);
    this.outgoing$.next(url);
  }

  private urlToAction(url: string): Action.IAction {
    let result: Action.IAction = null;

    if (url) {
      try {
        let [, raw] = url.split(`${Url.QUERY_FIELD_NAME}=`);
        [raw] = raw.split('&');

        if (raw) {
          const payload: Url.IPayload = JSON.parse(decodeURIComponent(raw), jsonReviver);
          if (
            payload.action &&
            payload.networkId === this.eth.getNetworkId()
          ) {
            result = payload.action;
          }
        }

      } catch (err) {
        result = null;
      }
    }

    return result;
  }

  private actionToUrl(action: Action.IAction, endpoint: string): string {
    let result: string = null;

    if (action && endpoint) {
      try {
        result = endpoint;
        if (result.includes('?')) {
          if (!result.endsWith('?')) {
            result = `${result}&`;
          }
        } else {
          result = `${result}?`;
        }

        const payload: Url.IPayload = {
          action,
          networkId: this.eth.getNetworkId(),
        };

        result = `${result}${Url.QUERY_FIELD_NAME}=${encodeURIComponent(JSON.stringify(payload, jsonReplacer))}`;
      } catch (err) {
        result = null;
      }
    }

    return result;
  }
}

export namespace Url {
  export interface IOptions {
    endpoint?: string;
  }

  export interface IAdapter {
    open(url: string): any;

    addListener(listener: (url: string) => any): void;

    removeListener?(listener: (url: string) => any): void;
  }

  export interface IPayload {
    networkId: string;
    action: Action.IAction;
  }
}
