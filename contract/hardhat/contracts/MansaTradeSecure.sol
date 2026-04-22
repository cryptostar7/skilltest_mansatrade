// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

interface IERC20Secure {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
}

library SafeERC20Secure {
    function safeTransfer(IERC20Secure token, address to, uint256 value) internal {
        _callOptionalReturn(token, abi.encodeWithSelector(token.transfer.selector, to, value));
    }

    function safeTransferFrom(IERC20Secure token, address from, address to, uint256 value) internal {
        _callOptionalReturn(token, abi.encodeWithSelector(token.transferFrom.selector, from, to, value));
    }

    function _callOptionalReturn(IERC20Secure token, bytes memory data) private {
        (bool success, bytes memory returndata) = address(token).call(data);
        require(success, "SafeERC20: low-level call failed");
        if (returndata.length > 0) {
            require(abi.decode(returndata, (bool)), "SafeERC20: ERC20 operation did not succeed");
        }
    }
}

contract MansaTradeSecure {
    using SafeERC20Secure for IERC20Secure;

    uint256 public constant FEE_DENOMINATOR = 10000;
    uint256 public constant SHARE_DENOMINATOR = 100;
    uint256 public constant MAX_FEE_BPS = 500; // 5% (effective charge is fee * 2)

    uint256 public fee = 45;
    uint256 public fir_fee = 80;
    uint256 public sec_fee = 20;

    address public owner;
    address public admin;
    address public fir_div;
    address public sec_div;

    bool private _locked;

    struct Offer {
        address owner;
        address token_address;
        string fiat;
        string rate;
        string payment_options;
        string public_key;
        string offer_terms;
        uint256 token_amount;
        uint256 min_limit;
        uint256 max_limit;
        uint256 bought;
        uint256 created_at;
        uint256 offer_index;
        uint8 time_limit;
        bool status;
        bool eth;
    }

    struct Order {
        address seller;
        string payment_option;
        string account_name;
        string account_mail;
        string receive_amount;
        uint8 status; // 0: created, 1: completed, 2: canceled
        bool buyer_confirm;
        bool seller_confirm;
        bool feedback;
        uint256 order_index;
        uint256 offer_index;
        uint256 sell_amount;
        uint256 created_at;
    }

    struct User {
        bool verified;
        uint256 thumbs_up;
        uint256 thumbs_down;
        uint8 region;
        address user_address;
        uint256[] offer_indexes;
        uint256[] order_indexes;
    }

    Offer[] internal offers;
    Order[] internal orders;
    mapping(address => User) internal users;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event AdminUpdated(address indexed previousAdmin, address indexed newAdmin);
    event FeeUpdated(uint256 fee, uint256 firFee, uint256 secFee);
    event FeeDividerUpdated(address indexed firDiv, address indexed secDiv);
    event CreateOrder(uint256 order_index);

    modifier onlyOwner() {
        require(msg.sender == owner, "Ownable: caller is not the owner");
        _;
    }

    modifier onlyAdmin() {
        require(msg.sender == admin, "You are not admin!");
        _;
    }

    modifier nonReentrant() {
        require(!_locked, "ReentrancyGuard: reentrant call");
        _locked = true;
        _;
        _locked = false;
    }

    constructor(address _admin, address _fir_div, address _sec_div) {
        require(_admin != address(0), "Admin is zero address");
        require(_fir_div != address(0), "First divider is zero address");
        require(_sec_div != address(0), "Second divider is zero address");
        owner = msg.sender;
        admin = _admin;
        fir_div = _fir_div;
        sec_div = _sec_div;
    }

    function updateAdmin(address newAdmin) external onlyOwner {
        require(newAdmin != address(0), "Admin is zero address");
        emit AdminUpdated(admin, newAdmin);
        admin = newAdmin;
    }

    function updateFee(uint256 _fee, uint256 _fir_fee, uint256 _sec_fee) external onlyAdmin {
        require(_fee <= MAX_FEE_BPS, "Fee too high");
        require(_fir_fee + _sec_fee == SHARE_DENOMINATOR, "Invalid fee shares");
        fee = _fee;
        fir_fee = _fir_fee;
        sec_fee = _sec_fee;
        emit FeeUpdated(_fee, _fir_fee, _sec_fee);
    }

    function updateFeeDivider(address _fir_div, address _sec_div) external onlyAdmin {
        require(_fir_div != address(0), "First divider is zero address");
        require(_sec_div != address(0), "Second divider is zero address");
        fir_div = _fir_div;
        sec_div = _sec_div;
        emit FeeDividerUpdated(_fir_div, _sec_div);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Ownable: new owner is the zero address");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function createOffer(
        address token_address,
        string memory fiat,
        string memory rate,
        string memory payment_options,
        string memory public_key,
        string memory offer_terms,
        uint8 time_limit,
        bool eth,
        uint256 token_amount,
        uint256 min_limit,
        uint256 max_limit
    ) external {
        _upsertUser(msg.sender);
        require(time_limit > 0, "Invalid time limit");
        require(token_amount > 0, "Invalid token amount");
        require(min_limit > 0 && min_limit <= max_limit, "Invalid limits");
        require(max_limit <= token_amount, "Max exceeds token amount");

        if (eth) {
            require(token_address == address(0), "ETH offer must use zero token");
        } else {
            require(token_address != address(0), "Token offer uses zero token");
        }

        uint256 offer_index = offers.length;
        offers.push(
            Offer(
                msg.sender,
                token_address,
                fiat,
                rate,
                payment_options,
                public_key,
                offer_terms,
                token_amount,
                min_limit,
                max_limit,
                0,
                block.timestamp,
                offer_index,
                time_limit,
                true,
                eth
            )
        );
        users[msg.sender].offer_indexes.push(offer_index);
    }

    function updateOffer(
        string memory _fiat,
        string memory _payment_options,
        string memory _offer_terms,
        uint8 _time_limit,
        uint256 offer_index,
        uint256 _token_amount,
        uint256 _min_limit,
        uint256 _max_limit
    ) external {
        require(offer_index < offers.length, "Invalid offer index");
        Offer storage offer = offers[offer_index];
        require(msg.sender == offer.owner, "You are not owner of offer.");
        require(_time_limit > 0, "Invalid time limit");
        require(_token_amount >= offer.bought, "Token amount below sold");
        require(_min_limit > 0 && _min_limit <= _max_limit, "Invalid limits");
        require(_max_limit <= _token_amount, "Max exceeds token amount");

        offer.fiat = _fiat;
        offer.payment_options = _payment_options;
        offer.offer_terms = _offer_terms;
        offer.time_limit = _time_limit;
        offer.token_amount = _token_amount;
        offer.min_limit = _min_limit;
        offer.max_limit = _max_limit;
    }

    function cancelOffer(uint256 offer_index) external {
        require(offer_index < offers.length, "Invalid offer index");
        require(msg.sender == offers[offer_index].owner, "You are not owner of offer.");
        offers[offer_index].status = false;
    }

    function createOrder(
        string memory payment_option,
        string memory account_name,
        string memory account_mail,
        string memory receive_amount,
        uint256 offer_index,
        uint256 sell_amount
    ) external payable nonReentrant {
        require(offer_index < offers.length, "Invalid offer index");
        Offer storage offer = offers[offer_index];
        require(offer.status, "Offer is inactive");
        require(sell_amount >= offer.min_limit && sell_amount <= offer.max_limit, "Sell amount out of range");
        require(sell_amount > 0, "Sell amount is zero");
        require(sell_amount <= offer.token_amount, "Insufficient offer amount");

        _upsertUser(msg.sender);

        if (offer.eth) {
            require(msg.value == sell_amount, "Please send as sell amount");
        } else {
            require(msg.value == 0, "ETH not accepted for token order");
            IERC20Secure token = IERC20Secure(offer.token_address);
            require(token.allowance(msg.sender, address(this)) >= sell_amount, "Please approve token as sell amount");
            token.safeTransferFrom(msg.sender, address(this), sell_amount);
        }

        uint256 order_index = orders.length;
        orders.push(
            Order(
                msg.sender,
                payment_option,
                account_name,
                account_mail,
                receive_amount,
                0,
                false,
                false,
                false,
                order_index,
                offer_index,
                sell_amount,
                block.timestamp
            )
        );

        users[msg.sender].order_indexes.push(order_index);
        users[offer.owner].order_indexes.push(order_index);
        emit CreateOrder(order_index);
    }

    function buyerConfirm(uint256 order_index) external {
        require(order_index < orders.length, "Invalid order index");
        Order storage order = orders[order_index];
        require(order.status == 0, "Order is not avaliable now.");
        uint256 offer_index = order.offer_index;
        require(msg.sender == offers[offer_index].owner, "You are not buyer of order.");
        order.buyer_confirm = true;
    }

    function confirmOrder(uint256 order_index) external nonReentrant {
        require(order_index < orders.length, "Invalid order index");
        Order storage order = orders[order_index];
        require(order.status == 0, "Order is not avaliable now.");
        require(order.buyer_confirm, "Buyer is not confirm order yet.");
        require(msg.sender == order.seller || msg.sender == owner, "You are not seller of order or not admin.");

        Offer storage offer = offers[order.offer_index];
        uint256 sellAmount = order.sell_amount;
        uint256 totalFee = (sellAmount * fee * 2) / FEE_DENOMINATOR;
        uint256 firAmount = (totalFee * fir_fee) / SHARE_DENOMINATOR;
        uint256 secAmount = (totalFee * sec_fee) / SHARE_DENOMINATOR;
        uint256 sellerAmount = sellAmount - totalFee;

        if (offer.eth) {
            _safeSendETH(order.seller, sellerAmount);
            _safeSendETH(fir_div, firAmount);
            _safeSendETH(sec_div, secAmount);
        } else {
            IERC20Secure token = IERC20Secure(offer.token_address);
            token.safeTransfer(order.seller, sellerAmount);
            token.safeTransfer(fir_div, firAmount);
            token.safeTransfer(sec_div, secAmount);
        }

        offer.token_amount -= sellAmount;
        offer.bought += sellAmount;
        if (offer.token_amount == 0) {
            offer.status = false;
        }

        order.seller_confirm = true;
        order.status = 1;
    }

    function cancelOrder(uint256 order_index) external nonReentrant {
        require(order_index < orders.length, "Invalid order index");
        Order storage order = orders[order_index];
        uint256 offer_index = order.offer_index;
        require(
            msg.sender == offers[offer_index].owner || msg.sender == order.seller || msg.sender == owner,
            "You are not buyer or seller or admin."
        );
        require(order.status != 1, "Order is completed.");

        uint256 sellAmount = order.sell_amount;
        if (offers[offer_index].eth) {
            _safeSendETH(order.seller, sellAmount);
        } else {
            IERC20Secure token = IERC20Secure(offers[offer_index].token_address);
            token.safeTransfer(order.seller, sellAmount);
        }

        order.status = 2;
    }

    function createUser() external {
        User storage user = users[msg.sender];
        require(user.user_address == address(0), "User already exists");
        user.verified = false;
        user.thumbs_up = 0;
        user.thumbs_down = 0;
        user.user_address = msg.sender;
    }

    function verifyUser(address _user) external onlyAdmin {
        require(_user != address(0), "Invalid user");
        _upsertUser(_user);
        users[_user].verified = true;
    }

    function updateUser(uint8 _region) external {
        _upsertUser(msg.sender);
        users[msg.sender].region = _region;
    }

    function thumbUser(bool flag, address _user, uint256 order_index) external {
        require(order_index < orders.length, "Invalid order index");
        require(msg.sender != _user, "You cannot claim yours");

        Order storage order = orders[order_index];
        require(!order.feedback, "Feedback already given");

        address buyer = offers[order.offer_index].owner;
        address seller = order.seller;

        require(
            (msg.sender == buyer || msg.sender == seller) && (_user == buyer || _user == seller),
            "Not participant"
        );
        require(msg.sender != _user, "You cannot claim yours");

        _upsertUser(_user);

        order.feedback = true;
        if (flag) users[_user].thumbs_up += 1;
        else users[_user].thumbs_down += 1;
    }

    function getUser(address _address) external view returns (User memory) {
        return users[_address];
    }

    function getOffers() external view returns (Offer[] memory) {
        return offers;
    }

    function getOrders() external view returns (Order[] memory) {
        return orders;
    }

    function getOfferByIndex(uint256 index) external view returns (Offer memory) {
        require(index < offers.length, "Invalid offer index");
        return offers[index];
    }

    function getOfferIndexesOfUser(address userAddress) external view returns (uint256[] memory) {
        return users[userAddress].offer_indexes;
    }

    function getOrderIndexesOfUser(address userAddress) external view returns (uint256[] memory) {
        return users[userAddress].order_indexes;
    }

    function getOrderByIndex(uint256 index) external view returns (Order memory) {
        require(index < orders.length, "Invalid order index");
        return orders[index];
    }

    function _upsertUser(address userAddress) internal {
        User storage user = users[userAddress];
        if (user.user_address == address(0)) {
            user.verified = false;
            user.thumbs_up = 0;
            user.thumbs_down = 0;
            user.user_address = userAddress;
        }
    }

    function _safeSendETH(address to, uint256 amount) internal {
        (bool ok, ) = payable(to).call{value: amount}("");
        require(ok, "ETH transfer failed");
    }
}
