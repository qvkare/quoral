// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title DisclosureRegistry
/// @notice Public index of agreements: termsHash (keccak of the ABI-encoded onchain Terms) → public JSON URI,
///         with issuer + MM attestations. Both parties attest on creation (issuer by awarding, MM by bonded bid);
///         changing the URI resets the MM attestation until it re-attests.
contract DisclosureRegistry {
    struct Disclosure {
        address issuer;
        address mm;
        address market;
        address baseToken;
        bytes32 termsHash;
        string uri;
        bool issuerAttested;
        bool mmAttested;
        uint64 createdAt;
    }

    error NotFactory();
    error NotParty();
    error NotIssuer();
    error AlreadySet();
    error Unknown();

    event Disclosed(
        address indexed agreement,
        address indexed baseToken,
        address indexed issuer,
        address mm,
        address market,
        bytes32 termsHash,
        string uri
    );
    event Attested(address indexed agreement, address indexed by);
    event URIUpdated(address indexed agreement, string uri);

    address public immutable deployer;
    address public factory;

    mapping(address agreement => Disclosure) internal _disclosures;
    mapping(address token => address[]) internal _byToken;
    address[] public allAgreements;

    constructor() {
        deployer = msg.sender;
    }

    function setFactory(address factory_) external {
        if (msg.sender != deployer || factory != address(0)) revert AlreadySet();
        factory = factory_;
    }

    function register(
        address agreement,
        address issuer,
        address mm,
        address market,
        address baseToken,
        bytes32 termsHash,
        string calldata uri
    ) external {
        if (msg.sender != factory) revert NotFactory();
        _disclosures[agreement] = Disclosure({
            issuer: issuer,
            mm: mm,
            market: market,
            baseToken: baseToken,
            termsHash: termsHash,
            uri: uri,
            issuerAttested: true,
            mmAttested: true,
            createdAt: uint64(block.number)
        });
        _byToken[baseToken].push(agreement);
        allAgreements.push(agreement);
        emit Disclosed(agreement, baseToken, issuer, mm, market, termsHash, uri);
    }

    function attest(address agreement) external {
        Disclosure storage d = _disclosures[agreement];
        if (d.issuer == address(0)) revert Unknown();
        if (msg.sender == d.issuer) d.issuerAttested = true;
        else if (msg.sender == d.mm) d.mmAttested = true;
        else revert NotParty();
        emit Attested(agreement, msg.sender);
    }

    function updateURI(address agreement, string calldata uri) external {
        Disclosure storage d = _disclosures[agreement];
        if (msg.sender != d.issuer) revert NotIssuer();
        d.uri = uri;
        d.mmAttested = false;
        emit URIUpdated(agreement, uri);
    }

    function disclosure(address agreement) external view returns (Disclosure memory) {
        return _disclosures[agreement];
    }

    function agreementsOf(address baseToken) external view returns (address[] memory) {
        return _byToken[baseToken];
    }

    function agreementCount() external view returns (uint256) {
        return allAgreements.length;
    }
}
