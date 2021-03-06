const debug = require('debug')('talk:services:wordlist');
const _ = require('lodash');
const {RegexpTokenizer} = require('natural');
const tokenizer = new RegexpTokenizer({pattern: /[.\s'"?!]/});
const nameTokenizer = new RegexpTokenizer({pattern: /_/});
const SettingsService = require('./settings');
const Errors = require('../errors');

// REGEX to prevent emoji's from entering the wordlist.
const EMOJI_REGEX = /(?:[\u2700-\u27bf]|(?:\ud83c[\udde6-\uddff]){2}|[\ud800-\udbff][\udc00-\udfff])[\ufe0e\ufe0f]?(?:[\u0300-\u036f\ufe20-\ufe23\u20d0-\u20f0]|\ud83c[\udffb-\udfff])?(?:\u200d(?:[^\ud800-\udfff]|(?:\ud83c[\udde6-\uddff]){2}|[\ud800-\udbff][\udc00-\udfff])[\ufe0e\ufe0f]?(?:[\u0300-\u036f\ufe20-\ufe23\u20d0-\u20f0]|\ud83c[\udffb-\udfff])?)*/;

/**
 * The root wordlist object.
 * @type {Object}
 */
class Wordlist {

  constructor() {
    this.lists = {
      banned: [],
      suspect: []
    };
  }

  /**
   * Loads wordlists in from the database
   */
  load() {
    return SettingsService
      .retrieve()
      .then((settings) => {

        // Insert the settings wordlist.
        this.upsert(settings.wordlist);
      });
  }

  /**
   * Inserts the wordlist data
   * @param  {Array} list list of words to be set to the wordlist
   */
  upsert(lists) {

    // Add the words to this array, but also lowercase the words so that an
    // easy comparison can take place.
    ['banned', 'suspect'].forEach((k) => {
      if (!(k in lists)) {
        return;
      }

      this.lists[k] = Wordlist.parseList(lists[k]);

      debug(`Added ${lists[k].length} words to the ${k} wordlist.`);
    });

    return Promise.resolve(this);
  }

  /**
   * Parses the list content.
   * @param  {Array} list array of words to parse for a list.
   * @return {Array}      the parsed list
   */
  static parseList(list) {
    return _.uniq(list.filter((word) => {
      if (EMOJI_REGEX.test(word)) {
        return false;
      }

      return true;
    })
      .map((word) => {
        if (word.length === 1) {
          return [word];
        }

        return tokenizer.tokenize(word.toLowerCase());
      })
      .filter((tokens) => {
        if (tokens.length === 0) {
          return false;
        }

        return true;
      }));
  }

  /**
   * Tests the phrase to see if it contains any of the defined blockwords.
   * @param  {String} phrase value to check for blockwords.
   * @return {Boolean}       true if a blockword is found, false otherwise.
   */
  match(list, phrase, tk = tokenizer) {

    // Lowercase the word to ensure that we don't miss a match due to
    // capitalization.
    let lowerPhraseWords = tk.tokenize(phrase.toLowerCase());

    // This will return true in the event that at least one blockword is found
    // in the phrase.
    return list.some((blockphrase) => {

      // First, let's see if we can find the first word in the blockphrase in the
      // source phrase.
      let idx = lowerPhraseWords.indexOf(blockphrase[0]);

      if (idx === -1) {

        // The first blockword in the blockphrase did not match the source phrase
        // anywhere.
        return false;
      }

      // Here we'll quick respond with true in the event that the blockphrase was
      // just a single word.
      if (blockphrase.length === 1) {
        return true;
      }

      // We found the first word in the source phrase! Lets ensure it matches the
      // rest of the blockphrase...

      // Check to see if it even has the length to support this word!
      if (lowerPhraseWords.length < idx + blockphrase.length - 1) {

        // We couldn't possibly have the entire phrase here because we don't have
        // enough entries!
        return false;
      }

      for (let i = 1; i < blockphrase.length; i++) {

        // Check to see if the next word also matches!
        if (lowerPhraseWords[idx + i] !== blockphrase[i]) {
          return false;
        }
      }

      // We've walked over all the words of the blockphrase, and haven't had a
      // mismatch... It does contain the whole word!
      return true;
    });
  }

  /**
   * Scans a specific field for wordlist violations.
   */
  scan(fieldName, phrase) {
    let errors = {};

    // If the field doesn't exist in the body, then it can't be profane!
    if (!phrase) {

      // Return that there wasn't a profane word here.
      return errors;
    }

    // Check if the field contains a banned word.
    if (this.match(this.lists.banned, phrase)) {
      debug(`the field "${fieldName}" contained a phrase "${phrase}" which contained a banned word/phrase`);

      errors.banned = Errors.ErrContainsProfanity;

      // Stop looping through the fields now, we discovered the worst possible
      // situation (a banned word).
      return errors;
    }

    // Check if the field contains a banned word.
    if (this.match(this.lists.suspect, phrase)) {
      debug(`the field "${fieldName}" contained a phrase "${phrase}" which contained a suspected word/phrase`);

      errors.suspect = Errors.ErrContainsProfanity;

      // Continue looping through the fields now, we discovered a possible bad
      // word (suspect).
      return errors;
    }
  }

  /**
   * Perform the filtering based on the loaded wordlists.
   */
  filter(body, ...fields) {

    // Start with the sensible default that the content does not contain
    // profanity.
    let errors = {};

    // Loop over all the fields from the body that we want to check.
    for (let i = 0; i < fields.length; i++) {
      let fieldName = fields[i];

      let phrase = _.get(body, fieldName, false);

      // If the field doesn't exist in the body, then it can't be profane!
      if (!phrase) {

        // Return that there wasn't a profane word here.
        continue;
      }

      errors = Object.assign(errors, this.scan(fieldName, phrase));

      // Check if the field contains a banned word.
      if (errors.banned) {

        // Stop looping through the fields now, we discovered the worst possible
        // situation (a banned word).
        break;
      }

      // Check if the field contains a banned word.
      if (errors.suspect) {

        // Continue looping through the fields now, we discovered a possible bad
        // word (suspect).
        continue;
      }
    }

    return errors;
  }

  /**
   * check potential username for banned words
   */
  static usernameCheck(username) {
    const wl = new Wordlist();

    return wl
      .load()
      .then(() => {
        if (!wl.checkName(wl.lists.banned, username)) {
          return Errors.ErrContainsProfanity;
        }
      });
  }

  checkName(list, name) {
    return !this.match(list, name, nameTokenizer);
  }

  /**
   * Connect middleware for scanning request bodies for wordlisted words and
   * attaching a ErrContainsProfanity to the req.wordlisted parameter, otherwise
   * it will just set that parameter to false.
   * @param  {Array} fields selectors for the body to extract the fields to be
   *                        tested
   * @return {Function}     the Connect middleware
   */
  static filter(...fields) {
    return async (req, res, next) => {

      // Create a new instance of the Wordlist.
      const wl = new Wordlist();

      try {

        await wl.load();

        // Perform a filtering operation using the new instance of the
        // Wordlist.
        req.wordlist = wl.filter(req.body, ...fields);

      } catch(err) {
        return next(err);
      }

      // Call the next piece of middleware.
      return next();
    };
  }
}

module.exports = Wordlist;
