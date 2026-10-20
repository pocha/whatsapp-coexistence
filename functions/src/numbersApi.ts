import { onRequest } from 'firebase-functions/v2/https';
import { handle, numberRoute } from './helpers/http';
import { exchangeCode } from './accounts';
import { getNotifications, getNumber, listNumbers } from './numbers';
import { deregisterNumber, disconnectNumber, numbersApp, registerNumber, setDisplayName, setWebhook } from './wabaManager';

// /numbers: the API for a customer's numbers, with the phone number ID in the path. Every call takes the
// Watobot API key as `Authorization: Bearer <key>`; the two reads also take the dashboard's sign-in. The relay
// (messages, limits) is registered in wabaManager.ts. A function has one timeout, the default minute here.
//
//   GET    /numbers                       the account's numbers
//   POST   /numbers                       a number from Embedded Signup's code (sign-in, and the key in the body)
//   GET    /numbers/<id>                  one number (with ?refresh=true and the key: live from Meta too)
//   GET    /numbers/<id>/notifications    what Meta has told us about it, newest first
//   PUT    /numbers/<id>/webhook          where incoming events go (or none)
//   PUT    /numbers/<id>/display-name     ask Meta to review a new name
//   POST   /numbers/<id>/register         register an API-only number (PIN)
//   POST   /numbers/<id>/deregister       take an API-only number off the Cloud API
//   POST   /numbers/<id>/disconnect       unsubscribe (and de-register an API-only number)
//   POST   /numbers/<id>/messages         send (the relay)
//   GET    /numbers/<id>/limits           template-send limits

const withKey = { keyRequired: true };
const keyOrSignIn = { keyRequired: false };

numbersApp.get('/', numberRoute(listNumbers, keyOrSignIn));
numbersApp.post('/', handle(exchangeCode));
numbersApp.get('/:phoneNumberId', numberRoute(getNumber, keyOrSignIn));
numbersApp.get('/:phoneNumberId/notifications', numberRoute(getNotifications, keyOrSignIn));
numbersApp.put('/:phoneNumberId/webhook', numberRoute(setWebhook, withKey));
numbersApp.put('/:phoneNumberId/display-name', numberRoute(setDisplayName, withKey));
numbersApp.post('/:phoneNumberId/register', numberRoute(registerNumber, withKey));
numbersApp.post('/:phoneNumberId/deregister', numberRoute(deregisterNumber, withKey));
numbersApp.post('/:phoneNumberId/disconnect', numberRoute(disconnectNumber, withKey));

export const numbers = onRequest(numbersApp);
