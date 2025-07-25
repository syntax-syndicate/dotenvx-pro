const { PrivateKey } = require('eciesjs')

// helpers
const Errors = require('./../helpers/errors')
const ValidateLoggedIn = require('./../helpers/validateLoggedIn')
const ValidatePublicKey = require('./../helpers/validatePublicKey')
const encryptValue = require('./../helpers/encryptValue')
const decryptValue = require('./../helpers/decryptValue')

// services
const SyncMe = require('./syncMe')
const SyncPublicKey = require('./syncPublicKey')
const SyncDevice = require('./syncDevice')
const SyncOrganization = require('./syncOrganization')
const SyncOrganizationPublicKey = require('./syncOrganizationPublicKey')

// db
const User = require('./../../db/user')
const Device = require('./../../db/device')
const current = require('./../../db/current')

// api calls
const PostMeDevicePrivateKeyEncrypted = require('./../api/postMeDevicePrivateKeyEncrypted')
const PostOrganizationUserPrivateKeyEncrypted = require('./../api/postOrganizationUserPrivateKeyEncrypted')

class Sync {
  constructor (hostname = current.hostname(), envFile = '.env') {
    this.hostname = hostname
    this.envFile = envFile
    this.device = new Device()
  }

  async run () {
    const slugs = []

    // logged in
    new ValidateLoggedIn().run()
    this.user = await new SyncMe(this.hostname, current.token()).run()

    // verify/sync public key
    new ValidatePublicKey().run()
    this.user = new User()
    // this.user = await new SyncPublicKey(this.hostname, current.token(), this.user.publicKey()).run() // should NOT be necessary

    // sync device
    this.user = await new SyncDevice(this.hostname, current.token(), this.device.publicKey(), this.device.encrypt(this.user.privateKey())).run()

    // device(s)
    const _deviceIds = this.user.deviceIds()
    if (!_deviceIds || _deviceIds.length < 1) {
      throw new Errors({ username: this.user.username() }).missingDevice()
    }

    // TODO: probably deprecate and leave for the app's UI maybe?? like the app could do this on a new login,
    // but the cli will get run more than the app login process. hmm, maybe still needs to be here. BUT
    // all new devices added will be synced from that initial oauth login handshake, so maybe this now
    // unnecessary and we provide an emergency sync in the front-end a user can go to if things seem off
    //
    // check for devices - and sync up the userPrivateKey between them
    const _deviceIdsMissingUserPrivateKeyEncrypted = this.user.deviceIdsMissingUserPrivateKeyEncrypted()
    if (_deviceIdsMissingUserPrivateKeyEncrypted || _deviceIdsMissingUserPrivateKeyEncrypted.length > 0) {
      for (let i = 0; i < _deviceIdsMissingUserPrivateKeyEncrypted.length; i++) {
        const deviceId = _deviceIdsMissingUserPrivateKeyEncrypted[i]

        // publicKey
        const devicePublicKey = this.user.store.get(`device/${deviceId}/public_key/1`)
        // encrypt user private key using device public key
        const userPrivateKeyEncryptedWithDevicePublicKey = encryptValue(this.user.privateKey(), devicePublicKey)

        // upload their private key encrypted for the device
        await new PostMeDevicePrivateKeyEncrypted(this.hostname, current.token(), deviceId, devicePublicKey, userPrivateKeyEncryptedWithDevicePublicKey).run()
      }
    }

    // organization(s)
    const _organizationIds = this.user.organizationIds()
    if (!_organizationIds || _organizationIds.length < 1) {
      throw new Errors({ username: this.user.username() }).missingOrganization()
    }

    let currentOrganizationId = current.organizationId()
    for (let iOrg = 0; iOrg < _organizationIds.length; iOrg++) {
      const organizationId = _organizationIds[iOrg]

      // for later - to auto-select an organization
      if (!currentOrganizationId) {
        currentOrganizationId = organizationId
      }

      let organization = await new SyncOrganization(this.hostname, current.token(), organizationId).run()

      // generate org keypair for the first time
      const organizationHasPublicKey = organization.publicKey() && organization.publicKey().length > 0
      if (!organizationHasPublicKey) {
        const kp = new PrivateKey()
        const genPublicKey = kp.publicKey.toHex()
        const genPrivateKey = kp.secret.toString('hex')
        const genPrivateKeyEncrypted = this.user.encrypt(genPrivateKey) // encrypt org private key with user's public key

        organization = await new SyncOrganizationPublicKey(this.hostname, current.token(), organizationId, genPublicKey, genPrivateKeyEncrypted).run()
        this.user = await new SyncPublicKey(this.hostname, current.token(), this.user.publicKey()).run()
      }

      const meHasPrivateKeyEncrypted = organization.privateKeyEncrypted() && organization.privateKeyEncrypted().length > 0
      if (!meHasPrivateKeyEncrypted) {
        throw new Errors({ slug: organization.slug() }).missingOrganizationPrivateKey()
      }

      const canDecryptOrganization = decryptValue(encryptValue('true', organization.publicKey()), organization.privateKey(this.user.privateKey()))
      if (canDecryptOrganization !== 'true') {
        throw new Errors({ slug: organization.slug() }).decryptionFailed()
      }

      // check team is all synced
      const _userIdsMissingPrivateKeyEncrypted = organization.userIdsMissingPrivateKeyEncrypted()
      if (_userIdsMissingPrivateKeyEncrypted || _userIdsMissingPrivateKeyEncrypted.length > 0) {
        for (let i = 0; i < _userIdsMissingPrivateKeyEncrypted.length; i++) {
          const userId = _userIdsMissingPrivateKeyEncrypted[i]

          // publicKey
          const publicKey = organization.store.get(`u/${userId}/pk/1`)

          if (!publicKey || publicKey.length < 1) {
            // const username = organization.store.get(`u/${userId}/un`)
            // TODO: how should I handle this? maybe collect all users that haven't run their first sync yet?
            // spinner.warn(`[@${organization.slug()}] teammate '${username}' missing public key. Tell them to run [dotenvx pro sync].`)
            // probably not needed going forward as we are going to sync in the browser, the chrome extension and the cli. they are bound to have generated their publicKey in one of those places
          } else {
            // encrypt organization private key using teammate's public key
            const privateKeyEncrypted = encryptValue(organization.privateKey(this.user.privateKey()), publicKey)
            // upload their encrypted private key to pro
            await new PostOrganizationUserPrivateKeyEncrypted(this.hostname, current.token(), organization.id(), userId, publicKey, privateKeyEncrypted).run()
          }
        }
      }

      organization = await new SyncOrganization(this.hostname, current.token(), organizationId).run()
      slugs.push(organization.slug())
    }

    current.selectOrganization(currentOrganizationId)

    return {
      username: this.user.username(),
      emergencyKitGeneratedAt: this.user.emergencyKitGeneratedAt(),
      slugs
    }
  }
}

module.exports = Sync
